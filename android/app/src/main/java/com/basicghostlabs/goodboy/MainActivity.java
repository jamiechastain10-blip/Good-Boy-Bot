/*
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * The Android app. It asks once for your dashboard link (Good Boy app on your computer > Settings > Dashboard link),
 * then opens its phone page (/app). Only your dashboard and Discord's login pages open inside the app; any other link
 * opens in the browser. Nothing is stored except the link; the login lives in the dashboard's own cookie.
 */
package com.basicghostlabs.goodboy;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    private static final String CONNECT = "file:///android_asset/connect.html";
    private static final String OFFLINE = "file:///android_asset/offline.html";
    private WebView web;
    private SharedPreferences prefs;
    private volatile boolean onOwnPage = false; // true while one of the app's own pages is showing

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("goodboy", MODE_PRIVATE);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptCookie(true);
        web.addJavascriptInterface(new Bridge(), "GoodBoyAndroid");
        web.setWebViewClient(new Client());
        if (state != null) web.restoreState(state);
        else openHome();
        handlePair(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handlePair(intent);
    }

    /**
     * A pairing link (goodboy://pair?url=...) comes from the dashboard page the phone opened by scanning the code in
     * the Good Boy app on the computer. Any website could make such a link, so the app asks before switching bots,
     * showing exactly which address it would connect to.
     */
    private void handlePair(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction()) || intent.getData() == null) return;
        Uri d = intent.getData();
        if (!"goodboy".equals(d.getScheme()) || !"pair".equals(d.getHost())) return;
        final String b = cleanBase(d.getQueryParameter("url"));
        intent.setData(null);
        if (b == null || b.equals(base())) { if (b != null) openHome(); return; }
        new AlertDialog.Builder(this)
            .setTitle("Connect to this bot?")
            .setMessage(Uri.parse(b).getHost() + "\n\nOnly connect to a dashboard link you got from your own Good Boy app.")
            .setPositiveButton("Connect", (dlg, w) -> { prefs.edit().putString("base", b).apply(); web.loadUrl(b + "/app"); })
            .setNegativeButton("Cancel", null)
            .show();
    }

    private String base() { return prefs.getString("base", null); }

    private void openHome() {
        String b = base();
        web.loadUrl(b == null ? CONNECT : b + "/app");
    }

    /** Only https links to a real host name are accepted. Returns the cleaned base (no path), or null. */
    static String cleanBase(String raw) {
        if (raw == null) return null;
        String t = raw.trim();
        if (t.isEmpty()) return null;
        if (!t.contains("://")) t = "https://" + t;
        Uri u = Uri.parse(t);
        String host = u.getHost();
        if (!"https".equals(u.getScheme()) || host == null || !host.contains(".") || host.contains(" ")) return null;
        return "https://" + host.toLowerCase() + (u.getPort() > 0 && u.getPort() != 443 ? ":" + u.getPort() : "");
    }

    private boolean isDiscord(String host) { return host != null && (host.equals("discord.com") || host.endsWith(".discord.com")); }

    private boolean isMine(Uri u) {
        String b = base();
        if (b == null || u.getHost() == null) return false;
        Uri bu = Uri.parse(b);
        return "https".equals(u.getScheme()) && u.getHost().equalsIgnoreCase(bu.getHost()) && u.getPort() == bu.getPort();
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            String scheme = u.getScheme();
            if ("file".equals(scheme)) return !u.toString().startsWith("file:///android_asset/");
            if (isMine(u) || ("https".equals(scheme) && isDiscord(u.getHost()))) return false; // stays in the app
            try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException e) { /* nothing can open it */ }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            onOwnPage = url != null && url.startsWith("file:///android_asset/");
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (req.isForMainFrame()) view.loadUrl(OFFLINE);
        }
    }

    /** What the app's own pages (and the phone page, for "Change bot link") can ask for. */
    private class Bridge {
        @JavascriptInterface
        public boolean connect(String raw) {
            if (!onOwnPage) return false; // only the app's own connect page may set the link
            String b = cleanBase(raw);
            if (b == null) return false;
            prefs.edit().putString("base", b).apply();
            runOnUiThread(() -> web.loadUrl(b + "/app"));
            return true;
        }

        @JavascriptInterface
        public String link() { return onOwnPage && base() != null ? base() : ""; }

        @JavascriptInterface
        public void retry() { runOnUiThread(MainActivity.this::openHome); }

        @JavascriptInterface
        public void changeLink() { runOnUiThread(() -> web.loadUrl(CONNECT)); }
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }
}
