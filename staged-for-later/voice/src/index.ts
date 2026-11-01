/**
 * Basic Ghost Labs - Project Eclipse
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * NOT verified end-to-end in this environment — the sandbox this was
 * written in has no network access and no ffmpeg/audio device to test
 * against a live voice connection. The code is structurally complete and
 * follows @discordjs/voice's documented patterns, but treat the first
 * real /tts call in your test server as the actual first test of this
 * module, and expect to iterate on it.
 *
 * Uses ffmpeg-static (a bundled ffmpeg binary) instead of requiring the
 * host machine to have ffmpeg installed system-wide, and opusscript (a
 * pure-JS opus encoder) instead of @discordjs/opus, since opusscript
 * doesn't need native compilation — more likely to "just work" on
 * whatever host you deploy to.
 */

import { defineModule } from "@platform/module-sdk";
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
  VoiceChannel,
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  getVoiceConnection,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
} from "@discordjs/voice";
import { Readable } from "stream";
import ffmpegPath from "ffmpeg-static";
import googleTTS from "google-tts-api";

process.env.FFMPEG_PATH = process.env.FFMPEG_PATH ?? (ffmpegPath as unknown as string);

const AUTO_LEAVE_MS = 5 * 60 * 1000; // 5 minutes idle

interface GuildVoiceState {
  player: ReturnType<typeof createAudioPlayer>;
  queue: string[]; // remaining text chunks to speak
  leaveTimer?: NodeJS.Timeout;
}

const guildStates = new Map<string, GuildVoiceState>();

async function fetchTtsAudioBuffer(text: string): Promise<Buffer> {
  const urls = googleTTS.getAllAudioUrls(text, { lang: "en", slow: false, host: "https://translate.google.com" });
  const buffers: Buffer[] = [];
  for (const u of urls) {
    const res = await fetch(u.url);
    buffers.push(Buffer.from(await res.arrayBuffer()));
  }
  return Buffer.concat(buffers);
}

function scheduleAutoLeave(guildId: string) {
  const state = guildStates.get(guildId);
  if (!state) return;
  clearTimeout(state.leaveTimer);
  state.leaveTimer = setTimeout(() => {
    getVoiceConnection(guildId)?.destroy();
    guildStates.delete(guildId);
  }, AUTO_LEAVE_MS);
}

async function playNext(guildId: string, context: any) {
  const state = guildStates.get(guildId);
  if (!state || state.queue.length === 0) {
    scheduleAutoLeave(guildId);
    return;
  }

  clearTimeout(state.leaveTimer);
  const text = state.queue.shift()!;

  try {
    const audioBuffer = await fetchTtsAudioBuffer(text);
    const resource = createAudioResource(Readable.from(audioBuffer), { inputType: StreamType.Arbitrary });
    state.player.play(resource);
  } catch (err) {
    context.logger.error("TTS playback failed", { error: (err as Error).message });
    void playNext(guildId, context); // skip the broken chunk, try the next
  }
}

export default defineModule({
  name: "voice",
  version: "1.0.0",
  type: "module",
  description: "Text-to-speech in voice channels, queued so messages don't overlap.",
  commands: [
    {
      name: "tts",
      description: "Speak a message in your current voice channel",
      data: new SlashCommandBuilder()
        .setName("tts")
        .setDescription("Speak a message in your current voice channel")
        .addStringOption((o) => o.setName("text").setDescription("What to say").setRequired(true))
        .toJSON(),
      async execute(rawInteraction, context) {
        const interaction = rawInteraction as ChatInputCommandInteraction;
        const member = interaction.member as GuildMember;
        const text = interaction.options.getString("text", true).slice(0, 500);
        const voiceChannel = member.voice.channel as VoiceChannel | null;

        if (!voiceChannel) {
          await interaction.reply({ content: "Join a voice channel first.", ephemeral: true });
          return;
        }

        const perms = voiceChannel.permissionsFor(interaction.guild!.members.me!);
        if (!perms?.has("Connect") || !perms.has("Speak")) {
          await interaction.reply({ content: "I don't have permission to join or speak in that channel.", ephemeral: true });
          return;
        }

        const guildId = interaction.guildId!;
        let state = guildStates.get(guildId);

        let connection = getVoiceConnection(guildId);
        if (!connection || connection.joinConfig.channelId !== voiceChannel.id) {
          connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId,
            adapterCreator: interaction.guild!.voiceAdapterCreator,
          });
          try {
            await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
          } catch {
            connection.destroy();
            await interaction.reply({ content: "Couldn't connect to that voice channel in time.", ephemeral: true });
            return;
          }
        }

        if (!state) {
          const player = createAudioPlayer();
          connection.subscribe(player);
          player.on(AudioPlayerStatus.Idle, () => void playNext(guildId, context));
          player.on("error", (err) => context.logger.error("Audio player error", { error: err.message }));
          state = { player, queue: [] };
          guildStates.set(guildId, state);
        }

        // Split into <=200 char chunks up front so long messages queue as
        // multiple pieces rather than failing the TTS API's length limit.
        for (let i = 0; i < text.length; i += 200) {
          state.queue.push(text.slice(i, i + 200));
        }

        await interaction.reply({ content: `🔊 Queued.`, ephemeral: true });

        if (state.player.state.status === AudioPlayerStatus.Idle) {
          void playNext(guildId, context);
        }
      },
    },
    {
      name: "tts-leave",
      description: "Disconnect the bot from voice and clear the queue",
      data: new SlashCommandBuilder().setName("tts-leave").setDescription("Disconnect the bot from voice").toJSON(),
      async execute(rawInteraction) {
        const interaction = rawInteraction as ChatInputCommandInteraction;
        const guildId = interaction.guildId!;
        getVoiceConnection(guildId)?.destroy();
        guildStates.delete(guildId);
        await interaction.reply({ content: "Disconnected.", ephemeral: true });
      },
    },
  ],
  async init(context) {
    context.logger.info("voice module initialized", { guildId: context.guildId });
  },
  async destroy(context) {
    if (context.guildId) {
      getVoiceConnection(context.guildId)?.destroy();
      guildStates.delete(context.guildId);
    }
    context.logger.info("voice module destroyed", { guildId: context.guildId });
  },
});
