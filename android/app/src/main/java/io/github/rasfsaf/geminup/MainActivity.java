package io.github.rasfsaf.geminup;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.InputType;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final String TAG = "geminUp";
    private static final String KEY_PROXY_RAW = "proxy_raw_config";
    private static final String KEY_PROXY_ENABLED = "proxy_enabled";
    private static final String KEY_PROXY_HISTORY = "proxy_history_list";

    private WebView webView;
    private SecurePreferences prefs;
    private LocalHttpToSocksBridge localBridge;
    private Button btnStatus;
    private Button btnMyProxies;
    private Button btnSetProxy;
    private Button btnToggleTerminal;
    private Button btnFloatGear;
    private LinearLayout controlBar;
    private LinearLayout terminalContainer;
    private TextView terminalOutput;
    private ScrollView terminalScroll;
    private boolean isTerminalVisible = false;
    private boolean isControlBarVisible = false;

    private static final String JS_SPOOF_INJECTION =
        "(function() {" +
        "  try {" +
        "    const TARGET_TIMEZONE = 'Europe/London';" +
        "    const TARGET_LOCALE = 'en-GB';" +
        "    const TARGET_LANGS = Object.freeze(['en-GB', 'en', 'en-US']);" +
        "    const SPOOF_COORDS = { latitude: 51.5074, longitude: -0.1278, accuracy: 15, altitude: null, altitudeAccuracy: null, heading: null, speed: null };" +
        "    const createPosition = () => ({ coords: SPOOF_COORDS, timestamp: Date.now() });" +
        "    if (navigator.geolocation) {" +
        "      navigator.geolocation.getCurrentPosition = function(s) { if(typeof s === 'function') setTimeout(() => s(createPosition()), 5); };" +
        "      navigator.geolocation.watchPosition = function(s) { if(typeof s === 'function') setTimeout(() => s(createPosition()), 5); return 100; };" +
        "      navigator.geolocation.clearWatch = function() {};" +
        "    }" +
        "    if (navigator.permissions && typeof navigator.permissions.query === 'function') {" +
        "      const origQ = navigator.permissions.query.bind(navigator.permissions);" +
        "      navigator.permissions.query = function(p) {" +
        "        if (p && p.name === 'geolocation') return Promise.resolve({ name: 'geolocation', state: 'granted', onchange: null, addEventListener: ()=>{}, removeEventListener: ()=>{}, dispatchEvent: ()=>true });" +
        "        return origQ(p);" +
        "      };" +
        "    }" +
        "    try {" +
        "      Object.defineProperty(navigator, 'language', { get: () => TARGET_LOCALE, configurable: true });" +
        "      Object.defineProperty(navigator, 'languages', { get: () => TARGET_LANGS, configurable: true });" +
        "    } catch(e) {}" +
        "    const OrigDTF = Intl.DateTimeFormat;" +
        "    function PatchedDTF(locales, options) {" +
        "      const opts = Object.assign({}, options);" +
        "      if (!opts.timeZone) opts.timeZone = TARGET_TIMEZONE;" +
        "      return new OrigDTF(locales || TARGET_LOCALE, opts);" +
        "    }" +
        "    PatchedDTF.prototype = OrigDTF.prototype;" +
        "    PatchedDTF.supportedLocalesOf = OrigDTF.supportedLocalesOf.bind(OrigDTF);" +
        "    PatchedDTF.prototype.resolvedOptions = function() { const o = OrigDTF.prototype.resolvedOptions.call(this); o.timeZone = TARGET_TIMEZONE; return o; };" +
        "    try { Intl.DateTimeFormat = PatchedDTF; } catch(e) {}" +
        "  } catch(err) { console.error('Spoof injection error:', err); }" +
        "})();";

    @Override
    @SuppressLint({"SetJavaScriptEnabled", "ClickableViewAccessibility"})
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        prefs = new SecurePreferences(this);

        FrameLayout rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(Color.BLACK);
        rootLayout.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        rootLayout.addView(webView);

        terminalContainer = new LinearLayout(this);
        terminalContainer.setOrientation(LinearLayout.VERTICAL);
        terminalContainer.setBackgroundColor(Color.parseColor("#E6000000"));
        FrameLayout.LayoutParams terminalParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                320
        );
        terminalParams.gravity = Gravity.TOP;
        terminalContainer.setLayoutParams(terminalParams);
        terminalContainer.setPadding(20, 20, 20, 20);
        terminalContainer.setVisibility(View.GONE);

        LinearLayout termTopBar = new LinearLayout(this);
        termTopBar.setOrientation(LinearLayout.HORIZONTAL);
        termTopBar.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams termTopParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        termTopBar.setLayoutParams(termTopParams);

        TextView terminalHeader = new TextView(this);
        terminalHeader.setText("> geminUp CLI Terminal [Ready]");
        terminalHeader.setTextColor(Color.parseColor("#00FF66"));
        terminalHeader.setTextSize(12f);
        terminalHeader.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        LinearLayout.LayoutParams thParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.0f);
        terminalHeader.setLayoutParams(thParams);
        termTopBar.addView(terminalHeader);

        Button btnCloseTerm = new Button(this);
        btnCloseTerm.setText("✕ Скрыть");
        btnCloseTerm.setTextSize(10f);
        btnCloseTerm.setTextColor(Color.parseColor("#00FF66"));
        btnCloseTerm.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        GradientDrawable closeShape = new GradientDrawable();
        closeShape.setShape(GradientDrawable.RECTANGLE);
        closeShape.setColor(Color.parseColor("#112211"));
        closeShape.setStroke(2, Color.parseColor("#00FF66"));
        btnCloseTerm.setBackground(closeShape);
        btnCloseTerm.setPadding(16, 8, 16, 8);
        btnCloseTerm.setOnClickListener(v -> toggleTerminalVisibility());
        termTopBar.addView(btnCloseTerm);

        terminalContainer.addView(termTopBar);

        terminalScroll = new ScrollView(this);
        LinearLayout.LayoutParams scrollParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        );
        scrollParams.setMargins(0, 10, 0, 0);
        terminalScroll.setLayoutParams(scrollParams);

        terminalOutput = new TextView(this);
        terminalOutput.setTextColor(Color.parseColor("#33FF33"));
        terminalOutput.setTextSize(11f);
        terminalOutput.setTypeface(Typeface.MONOSPACE);
        terminalOutput.setText("$ Initializing geminUp client...\n$ Loading proxy configuration...");
        terminalScroll.addView(terminalOutput);
        terminalContainer.addView(terminalScroll);
        rootLayout.addView(terminalContainer);

        controlBar = new LinearLayout(this);
        controlBar.setOrientation(LinearLayout.HORIZONTAL);
        controlBar.setGravity(Gravity.CENTER_VERTICAL);
        controlBar.setPadding(14, 10, 14, 10);
        GradientDrawable cbShape = new GradientDrawable();
        cbShape.setShape(GradientDrawable.RECTANGLE);
        cbShape.setColor(Color.parseColor("#E60D1B0D"));
        cbShape.setStroke(2, Color.parseColor("#00FF66"));
        controlBar.setBackground(cbShape);
        FrameLayout.LayoutParams barParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
        );
        barParams.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
        barParams.setMargins(0, 0, 0, 80);
        controlBar.setLayoutParams(barParams);
        controlBar.setVisibility(View.GONE);

        btnToggleTerminal = new Button(this);
        btnToggleTerminal.setText(">_");
        btnToggleTerminal.setTextSize(11f);
        btnToggleTerminal.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        btnToggleTerminal.setPadding(16, 10, 16, 10);
        btnToggleTerminal.setTextColor(Color.parseColor("#00FF66"));
        GradientDrawable termBtnShape = new GradientDrawable();
        termBtnShape.setShape(GradientDrawable.RECTANGLE);
        termBtnShape.setColor(Color.parseColor("#0D1B0D"));
        termBtnShape.setStroke(2, Color.parseColor("#00FF66"));
        btnToggleTerminal.setBackground(termBtnShape);
        LinearLayout.LayoutParams termBtnParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        );
        termBtnParams.setMargins(0, 0, 10, 0);
        btnToggleTerminal.setLayoutParams(termBtnParams);
        btnToggleTerminal.setOnClickListener(v -> toggleTerminalVisibility());
        controlBar.addView(btnToggleTerminal);

        btnMyProxies = new Button(this);
        btnMyProxies.setText("Мои");
        btnMyProxies.setTextSize(11f);
        btnMyProxies.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        btnMyProxies.setPadding(16, 10, 16, 10);
        btnMyProxies.setTextColor(Color.parseColor("#00FF66"));
        GradientDrawable myProxiesShape = new GradientDrawable();
        myProxiesShape.setShape(GradientDrawable.RECTANGLE);
        myProxiesShape.setColor(Color.parseColor("#0D1B0D"));
        myProxiesShape.setStroke(2, Color.parseColor("#00FF66"));
        btnMyProxies.setBackground(myProxiesShape);
        LinearLayout.LayoutParams myProxiesParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        );
        myProxiesParams.setMargins(0, 0, 10, 0);
        btnMyProxies.setLayoutParams(myProxiesParams);
        btnMyProxies.setOnClickListener(v -> showMyProxiesDialog());
        controlBar.addView(btnMyProxies);

        btnSetProxy = new Button(this);
        btnSetProxy.setText("+");
        btnSetProxy.setTextSize(11f);
        btnSetProxy.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        btnSetProxy.setPadding(16, 10, 16, 10);
        btnSetProxy.setTextColor(Color.parseColor("#00FF66"));
        GradientDrawable setProxyShape = new GradientDrawable();
        setProxyShape.setShape(GradientDrawable.RECTANGLE);
        setProxyShape.setColor(Color.parseColor("#0D1B0D"));
        setProxyShape.setStroke(2, Color.parseColor("#00FF66"));
        btnSetProxy.setBackground(setProxyShape);
        LinearLayout.LayoutParams setProxyParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        );
        setProxyParams.setMargins(0, 0, 10, 0);
        btnSetProxy.setLayoutParams(setProxyParams);
        btnSetProxy.setOnClickListener(v -> showProxyDialog());
        controlBar.addView(btnSetProxy);

        btnStatus = new Button(this);
        btnStatus.setTextSize(11f);
        btnStatus.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        btnStatus.setPadding(18, 10, 18, 10);
        updateButtonVisualState();
        btnStatus.setOnClickListener(v -> toggleProxyOrOpenSettings());
        controlBar.addView(btnStatus);

        rootLayout.addView(controlBar);

        btnFloatGear = new Button(this);
        btnFloatGear.setText("⚙");
        btnFloatGear.setTextSize(16f);
        btnFloatGear.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        btnFloatGear.setTextColor(Color.parseColor("#00FF66"));
        GradientDrawable gearShape = new GradientDrawable();
        gearShape.setShape(GradientDrawable.RECTANGLE);
        gearShape.setColor(Color.parseColor("#E6000000"));
        gearShape.setStroke(2, Color.parseColor("#00FF66"));
        btnFloatGear.setBackground(gearShape);
        btnFloatGear.setPadding(16, 12, 16, 12);
        FrameLayout.LayoutParams gearParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
        );
        gearParams.gravity = Gravity.TOP | Gravity.START;
        gearParams.setMargins(30, 200, 0, 0);
        btnFloatGear.setLayoutParams(gearParams);
        makeDraggable(btnFloatGear);
        rootLayout.addView(btnFloatGear);

        setContentView(rootLayout);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setGeolocationEnabled(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setUserAgentString("Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36");

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                callback.invoke(origin, false, false);
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                logTerminal("Loading: " + url);
                view.evaluateJavascript(JS_SPOOF_INJECTION, null);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                logTerminal("Page loaded: " + url);
                view.evaluateJavascript(JS_SPOOF_INJECTION, null);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request != null && request.getUrl() != null) {
                    String url = request.getUrl().toString();
                    if (url.contains("hl=ru") || (url.contains("gemini.google.com") && !url.contains("hl=en-GB"))) {
                        if (url.contains("hl=")) {
                            url = url.replaceAll("hl=[^&]+", "hl=en-GB");
                        } else {
                            url = url + (url.contains("?") ? "&hl=en-GB" : "?hl=en-GB");
                        }
                        Map<String, String> headers = new HashMap<>();
                        headers.put("Accept-Language", "en-GB,en;q=0.9,en-US;q=0.8");
                        view.loadUrl(url, headers);
                        return true;
                    }
                }
                return false;
            }
        });

        applyConfiguredProxyAndLoad();
    }

    @SuppressLint("ClickableViewAccessibility")
    private void makeDraggable(View view) {
        view.setOnTouchListener(new View.OnTouchListener() {
            private float dX, dY;
            private float startX, startY;
            private static final int CLICK_ACTION_THRESHOLD = 15;

            @Override
            public boolean onTouch(View v, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        dX = v.getX() - event.getRawX();
                        dY = v.getY() - event.getRawY();
                        startX = event.getRawX();
                        startY = event.getRawY();
                        return true;

                    case MotionEvent.ACTION_MOVE:
                        float newX = event.getRawX() + dX;
                        float newY = event.getRawY() + dY;
                        View parent = (View) v.getParent();
                        if (parent != null) {
                            int maxX = parent.getWidth() - v.getWidth();
                            int maxY = parent.getHeight() - v.getHeight();
                            if (newX < 0) newX = 0;
                            if (newX > maxX) newX = maxX;
                            if (newY < 0) newY = 0;
                            if (newY > maxY) newY = maxY;
                        }
                        v.setX(newX);
                        v.setY(newY);
                        return true;

                    case MotionEvent.ACTION_UP:
                        float diffX = Math.abs(event.getRawX() - startX);
                        float diffY = Math.abs(event.getRawY() - startY);
                        if (diffX < CLICK_ACTION_THRESHOLD && diffY < CLICK_ACTION_THRESHOLD) {
                            toggleControlBarVisibility();
                        }
                        return true;
                    default:
                        return false;
                }
            }
        });
    }

    private void toggleTerminalVisibility() {
        isTerminalVisible = !isTerminalVisible;
        terminalContainer.setVisibility(isTerminalVisible ? View.VISIBLE : View.GONE);
    }

    private void toggleControlBarVisibility() {
        isControlBarVisible = !isControlBarVisible;
        controlBar.setVisibility(isControlBarVisible ? View.VISIBLE : View.GONE);
        btnFloatGear.setText(isControlBarVisible ? "✕" : "⚙");
    }

    private void logTerminal(String msg) {
        runOnUiThread(() -> {
            if (terminalOutput != null) {
                terminalOutput.append("\n$ " + msg);
                if (terminalScroll != null) {
                    terminalScroll.post(() -> terminalScroll.fullScroll(View.FOCUS_DOWN));
                }
            }
        });
    }

    private void updateButtonVisualState() {
        if (btnStatus == null) return;
        boolean isEnabled = prefs.getBoolean(KEY_PROXY_ENABLED, true);
        String proxyStr = prefs.getString(KEY_PROXY_RAW, "");
        boolean hasProxy = !proxyStr.trim().isEmpty() && isEnabled;

        GradientDrawable shape = new GradientDrawable();
        shape.setShape(GradientDrawable.RECTANGLE);
        shape.setCornerRadius(0f);
        if (hasProxy) {
            shape.setColor(Color.parseColor("#003300"));
            shape.setStroke(2, Color.parseColor("#00FF66"));
            btnStatus.setText("ON");
            btnStatus.setTextColor(Color.parseColor("#00FF66"));
        } else {
            shape.setColor(Color.parseColor("#220000"));
            shape.setStroke(2, Color.parseColor("#FF3333"));
            btnStatus.setText("OFF");
            btnStatus.setTextColor(Color.parseColor("#FF3333"));
        }
        btnStatus.setBackground(shape);
    }

    private void toggleProxyOrOpenSettings() {
        String proxyStr = prefs.getString(KEY_PROXY_RAW, "");
        if (proxyStr.trim().isEmpty()) {
            showProxyDialog();
            return;
        }
        boolean current = prefs.getBoolean(KEY_PROXY_ENABLED, true);
        prefs.edit().putBoolean(KEY_PROXY_ENABLED, !current).apply();
        logTerminal("Proxy toggled: " + (!current ? "ENABLED" : "DISABLED"));
        applyConfiguredProxyAndLoad();
    }

    private List<String> getProxyHistory() {
        List<String> list = new ArrayList<>();
        String json = prefs.getString(KEY_PROXY_HISTORY, "[]");
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                String item = arr.getString(i);
                if (item != null && !item.trim().isEmpty() && !list.contains(item.trim())) {
                    list.add(item.trim());
                }
            }
        } catch (Exception error) {
            Log.w(TAG, "Cannot read the local proxy history; ignoring the damaged value.", error);
        }
        return list;
    }

    private void saveProxyToHistory(String proxy) {
        if (proxy == null || proxy.trim().isEmpty()) return;
        proxy = proxy.trim();
        List<String> list = getProxyHistory();
        list.remove(proxy);
        list.add(0, proxy);
        JSONArray arr = new JSONArray();
        for (String p : list) {
            arr.put(p);
        }
        prefs.edit().putString(KEY_PROXY_HISTORY, arr.toString()).apply();
    }

    private void applyConfiguredProxyAndLoad() {
        updateButtonVisualState();
        boolean isEnabled = prefs.getBoolean(KEY_PROXY_ENABLED, true);
        String proxyStr = prefs.getString(KEY_PROXY_RAW, "");

        ProxyConfigHolder parsed = parseProxy(proxyStr);

        if (localBridge != null) {
            localBridge.stop();
            localBridge = null;
        }

        if (isEnabled && parsed != null && parsed.isValid()) {
            try {
                saveProxyToHistory(proxyStr);
                localBridge = new LocalHttpToSocksBridge(parsed.host, parsed.port, parsed.user, parsed.pass);
                localBridge.start();
                int localPort = localBridge.getLocalPort();
                logTerminal("Local Bridge active on 127.0.0.1:" + localPort + " -> SOCKS5 " + parsed.host + ":" + parsed.port);

                if (WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
                    String proxyUrl = "http://127.0.0.1:" + localPort;
                    ProxyConfig proxyConfig = new ProxyConfig.Builder()
                            .addProxyRule(proxyUrl)
                            .build();
                    ProxyController.getInstance().setProxyOverride(proxyConfig, Executors.newSingleThreadExecutor(), () -> {
                        runOnUiThread(() -> {
                            logTerminal("Proxy override set successfully.");
                            loadInitialUrl();
                        });
                    });
                    return;
                } else {
                    logTerminal("WARN: PROXY_OVERRIDE not supported by system WebView.");
                }
            } catch (Exception e) {
                logTerminal("ERROR: " + e.getMessage());
                Toast.makeText(this, "Proxy error: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        } else {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
                ProxyController.getInstance().clearProxyOverride(Executors.newSingleThreadExecutor(), () -> {
                    runOnUiThread(() -> {
                        logTerminal("Proxy override cleared (Direct Connection).");
                        loadInitialUrl();
                    });
                });
                return;
            }
        }
        loadInitialUrl();
    }

    private void loadInitialUrl() {
        Map<String, String> extraHeaders = new HashMap<>();
        extraHeaders.put("Accept-Language", "en-GB,en;q=0.9,en-US;q=0.8");
        String url = "https://gemini.google.com/?hl=en-GB";
        logTerminal("Connecting to " + url);
        webView.loadUrl(url, extraHeaders);
    }

    private void showMyProxiesDialog() {
        List<String> list = getProxyHistory();
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("Сохраненные Прокси");

        if (list.isEmpty()) {
            TextView emptyView = new TextView(this);
            emptyView.setText("Список прокси пуст. Добавьте прокси через кнопку '+ Прокси'.");
            emptyView.setPadding(50, 40, 50, 40);
            emptyView.setTypeface(Typeface.MONOSPACE);
            builder.setView(emptyView);
            builder.setPositiveButton("Добавить", (d, w) -> showProxyDialog());
            builder.setNegativeButton("Закрыть", null);
            builder.show();
            return;
        }

        String[] items = list.toArray(new String[0]);
        String[] labels = new String[items.length];
        for (int index = 0; index < items.length; index++) {
            labels[index] = safeProxyLabel(items[index]);
        }
        builder.setItems(labels, (dialog, which) -> {
            String selected = items[which];
            prefs.edit().putString(KEY_PROXY_RAW, selected).putBoolean(KEY_PROXY_ENABLED, true).apply();
            logTerminal("Selected proxy: " + safeProxyLabel(selected));
            Toast.makeText(this, "Применен прокси: " + safeProxyLabel(selected), Toast.LENGTH_SHORT).show();
            applyConfiguredProxyAndLoad();
        });

        builder.setPositiveButton("Новый прокси", (d, w) -> showProxyDialog());
        builder.setNeutralButton("Очистить все", (d, w) -> {
            prefs.edit().remove(KEY_PROXY_HISTORY).apply();
            logTerminal("Proxy history cleared.");
            Toast.makeText(this, "История очищена", Toast.LENGTH_SHORT).show();
        });
        builder.setNegativeButton("Закрыть", null);
        builder.show();
    }

    private void showProxyDialog() {
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("Настройка SOCKS5 Прокси");

        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setPadding(50, 30, 50, 20);

        TextView hintText = new TextView(this);
        hintText.setText("Форматы SOCKS5:\n• ip:port:user:pass\n• user:pass@ip:port\n• ip:port");
        hintText.setTextSize(13f);
        hintText.setTypeface(Typeface.MONOSPACE);
        hintText.setPadding(0, 0, 0, 16);
        container.addView(hintText);

        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        input.setTypeface(Typeface.MONOSPACE);
        String current = prefs.getString(KEY_PROXY_RAW, "");
        input.setText(current);
        input.setHint("proxy.example:1080:user:password");
        container.addView(input);

        builder.setView(container);

        builder.setPositiveButton("Сохранить и включить", (dialog, which) -> {
            String val = input.getText().toString().trim();
            if (!val.isEmpty()) {
                saveProxyToHistory(val);
            }
            prefs.edit().putString(KEY_PROXY_RAW, val).putBoolean(KEY_PROXY_ENABLED, true).apply();
            logTerminal("Proxy configured: " + safeProxyLabel(val));
            Toast.makeText(this, "Прокси сохранен и применяется...", Toast.LENGTH_SHORT).show();
            applyConfiguredProxyAndLoad();
        });

        builder.setNegativeButton("Отключить", (dialog, which) -> {
            prefs.edit().putBoolean(KEY_PROXY_ENABLED, false).apply();
            logTerminal("Proxy disabled by user.");
            Toast.makeText(this, "Прокси отключен", Toast.LENGTH_SHORT).show();
            applyConfiguredProxyAndLoad();
        });

        builder.setNeutralButton("Отмена", null);
        builder.show();
    }

    private static class ProxyConfigHolder {
        String host;
        int port;
        String user;
        String pass;

        boolean isValid() {
            return host != null && !host.isEmpty() && port > 0 && port <= 65535;
        }
    }

    private static String safeProxyLabel(String raw) {
        ProxyConfigHolder parsed = parseProxy(raw);
        if (parsed == null || !parsed.isValid()) return "invalid proxy";
        return parsed.host + ":" + parsed.port;
    }

    private static ProxyConfigHolder parseProxy(String raw) {
        if (raw == null || raw.trim().isEmpty()) return null;
        raw = raw.trim();
        if (raw.startsWith("socks5://")) raw = raw.substring(9);
        else if (raw.startsWith("socks4://")) raw = raw.substring(9);
        else if (raw.startsWith("http://")) raw = raw.substring(7);
        else if (raw.startsWith("https://")) raw = raw.substring(8);

        raw = raw.trim();
        ProxyConfigHolder cfg = new ProxyConfigHolder();
        try {
            if (raw.contains("@")) {
                String[] atSplit = raw.split("@", 2);
                String auth = atSplit[0];
                String hostPort = atSplit[1];
                if (auth.contains(":")) {
                    String[] authSplit = auth.split(":", 2);
                    cfg.user = authSplit[0];
                    cfg.pass = authSplit[1];
                } else {
                    cfg.user = auth;
                }
                String[] hpSplit = hostPort.split(":");
                cfg.host = hpSplit[0];
                cfg.port = Integer.parseInt(hpSplit[1]);
                return cfg;
            }
            String[] parts = raw.split(":");
            if (parts.length >= 2) {
                cfg.host = parts[0];
                cfg.port = Integer.parseInt(parts[1]);
                if (parts.length >= 4) {
                    cfg.user = parts[2];
                    cfg.pass = parts[3];
                }
                return cfg;
            }
        } catch (Exception error) {
            Log.w(TAG, "Invalid local proxy configuration format.", error);
        }
        return null;
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (localBridge != null) {
            localBridge.stop();
        }
    }

    public static class LocalHttpToSocksBridge {
        private final String socksHost;
        private final int socksPort;
        private final String socksUser;
        private final String socksPass;
        private ServerSocket serverSocket;
        private volatile boolean running = false;
        private final ExecutorService executor = Executors.newCachedThreadPool();

        public LocalHttpToSocksBridge(String host, int port, String user, String pass) {
            this.socksHost = host;
            this.socksPort = port;
            this.socksUser = user;
            this.socksPass = pass;
        }

        public void start() throws Exception {
            serverSocket = new ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"));
            running = true;
            executor.submit(this::listenLoop);
        }

        public int getLocalPort() {
            return serverSocket != null ? serverSocket.getLocalPort() : -1;
        }

        public void stop() {
            running = false;
            try {
                if (serverSocket != null) serverSocket.close();
            } catch (Exception error) {
                Log.d(TAG, "Local bridge socket was already closed.", error);
            }
            executor.shutdownNow();
        }

        private void listenLoop() {
            while (running && !serverSocket.isClosed()) {
                try {
                    Socket client = serverSocket.accept();
                    executor.submit(() -> handleClient(client));
                } catch (Exception e) {
                    if (!running) break;
                    Log.w(TAG, "Local bridge accept failed.", e);
                }
            }
        }

        private void handleClient(Socket client) {
            Socket upstreamSocks = null;
            try {
                client.setSoTimeout(30000);
                InputStream in = client.getInputStream();
                OutputStream out = client.getOutputStream();

                String reqLine = readLine(in);
                if (reqLine == null || reqLine.isEmpty()) {
                    client.close();
                    return;
                }

                String[] parts = reqLine.split(" ");
                if (parts.length < 2) {
                    client.close();
                    return;
                }

                String method = parts[0].toUpperCase(Locale.ROOT);
                String target = parts[1];

                String targetHost;
                int targetPort;

                if (method.equals("CONNECT")) {
                    String[] hp = target.split(":");
                    targetHost = hp[0];
                    targetPort = hp.length > 1 ? Integer.parseInt(hp[1]) : 443;
                    while (true) {
                        String h = readLine(in);
                        if (h == null || h.isEmpty()) break;
                    }
                } else {
                    if (target.startsWith("http://")) {
                        target = target.substring(7);
                    }
                    int slashIdx = target.indexOf('/');
                    String hostPart = slashIdx != -1 ? target.substring(0, slashIdx) : target;
                    if (hostPart.contains(":")) {
                        String[] hp = hostPart.split(":");
                        targetHost = hp[0];
                        targetPort = Integer.parseInt(hp[1]);
                    } else {
                        targetHost = hostPart;
                        targetPort = 80;
                    }
                }

                upstreamSocks = new Socket();
                upstreamSocks.connect(new InetSocketAddress(socksHost, socksPort), 15000);
                upstreamSocks.setSoTimeout(30000);

                InputStream sIn = upstreamSocks.getInputStream();
                OutputStream sOut = upstreamSocks.getOutputStream();

                boolean hasAuth = (socksUser != null && !socksUser.isEmpty());
                if (hasAuth) {
                    sOut.write(new byte[]{0x05, 0x02, 0x00, 0x02});
                } else {
                    sOut.write(new byte[]{0x05, 0x01, 0x00});
                }
                sOut.flush();

                int sVer = sIn.read();
                int sMethod = sIn.read();
                if (sVer != 0x05) throw new RuntimeException("Invalid SOCKS5 version: " + sVer);

                if (sMethod == 0x02 && hasAuth) {
                    byte[] uBytes = socksUser.getBytes(StandardCharsets.UTF_8);
                    byte[] pBytes = (socksPass != null ? socksPass : "").getBytes(StandardCharsets.UTF_8);
                    byte[] authReq = new byte[3 + uBytes.length + pBytes.length];
                    authReq[0] = 0x01;
                    authReq[1] = (byte) uBytes.length;
                    System.arraycopy(uBytes, 0, authReq, 2, uBytes.length);
                    authReq[2 + uBytes.length] = (byte) pBytes.length;
                    System.arraycopy(pBytes, 0, authReq, 3 + uBytes.length, pBytes.length);
                    sOut.write(authReq);
                    sOut.flush();

                    int aVer = sIn.read();
                    int aStatus = sIn.read();
                    if (aStatus != 0x00) throw new RuntimeException("SOCKS5 Auth failed status: " + aStatus);
                } else if (sMethod != 0x00) {
                    throw new RuntimeException("SOCKS5 Unsupported auth method: " + sMethod);
                }

                byte[] hostBytes = targetHost.getBytes(StandardCharsets.UTF_8);
                byte[] connReq = new byte[7 + hostBytes.length];
                connReq[0] = 0x05;
                connReq[1] = 0x01;
                connReq[2] = 0x00;
                connReq[3] = 0x03;
                connReq[4] = (byte) hostBytes.length;
                System.arraycopy(hostBytes, 0, connReq, 5, hostBytes.length);
                connReq[5 + hostBytes.length] = (byte) ((targetPort >> 8) & 0xFF);
                connReq[6 + hostBytes.length] = (byte) (targetPort & 0xFF);
                sOut.write(connReq);
                sOut.flush();

                int cVer = sIn.read();
                int cRep = sIn.read();
                sIn.read();
                int cAtyp = sIn.read();
                if (cRep != 0x00) throw new RuntimeException("SOCKS5 Connect rejected code: " + cRep);

                if (cAtyp == 0x01) {
                    byte[] ip = new byte[4];
                    sIn.read(ip);
                } else if (cAtyp == 0x03) {
                    int dLen = sIn.read();
                    byte[] d = new byte[dLen];
                    sIn.read(d);
                } else if (cAtyp == 0x04) {
                    byte[] ip6 = new byte[16];
                    sIn.read(ip6);
                }
                sIn.read();
                sIn.read();

                if (method.equals("CONNECT")) {
                    out.write("HTTP/1.1 200 Connection Established\r\n\r\n".getBytes(StandardCharsets.UTF_8));
                    out.flush();
                } else {
                    out.write(reqLine.getBytes(StandardCharsets.UTF_8));
                    out.write("\r\n".getBytes(StandardCharsets.UTF_8));
                    out.flush();
                }

                Socket finalUpstream = upstreamSocks;
                Socket finalClient = client;

                Thread t1 = new Thread(() -> pipe(in, sOut, finalClient, finalUpstream));
                Thread t2 = new Thread(() -> pipe(sIn, out, finalUpstream, finalClient));
                t1.start();
                t2.start();
            } catch (Exception e) {
                Log.w(TAG, "Local bridge connection failed.", e);
                try {
                    if (client != null) client.close();
                } catch (Exception closeError) {
                    Log.d(TAG, "Client socket close failed.", closeError);
                }
                try {
                    if (upstreamSocks != null) upstreamSocks.close();
                } catch (Exception closeError) {
                    Log.d(TAG, "SOCKS socket close failed.", closeError);
                }
            }
        }

        private static void pipe(InputStream in, OutputStream out, Socket s1, Socket s2) {
            byte[] buf = new byte[16384];
            try {
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                    out.flush();
                }
            } catch (Exception error) {
                Log.d(TAG, "Proxy relay finished.", error);
            } finally {
                try { s1.close(); } catch (Exception closeError) { Log.d(TAG, "Relay socket close failed.", closeError); }
                try { s2.close(); } catch (Exception closeError) { Log.d(TAG, "Relay socket close failed.", closeError); }
            }
        }

        private static String readLine(InputStream in) throws Exception {
            StringBuilder sb = new StringBuilder();
            int c;
            while ((c = in.read()) != -1) {
                if (c == '\r') continue;
                if (c == '\n') break;
                sb.append((char) c);
            }
            return sb.toString();
        }
    }
}
