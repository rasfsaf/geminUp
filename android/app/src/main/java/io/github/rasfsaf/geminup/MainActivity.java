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
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

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
    private final ExecutorService backgroundExecutor = Executors.newCachedThreadPool();
    private final AtomicInteger proxyGeneration = new AtomicInteger();

    private volatile GeoProfile currentGeoProfile = GeoProfile.getDefault();

    public static class GeoProfile {
        public final String countryCode;
        public final String timeZone;
        public final String locale;
        public final String[] languages;
        public final double latitude;
        public final double longitude;

        public GeoProfile(String countryCode, String timeZone, String locale, String[] languages, double latitude, double longitude) {
            this.countryCode = countryCode;
            this.timeZone = timeZone;
            this.locale = locale;
            this.languages = languages;
            this.latitude = latitude;
            this.longitude = longitude;
        }

        public String getAcceptLanguageHeader() {
            if ("de-DE".equals(locale)) {
                return "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7";
            } else if ("fr-FR".equals(locale)) {
                return "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7";
            } else if ("en-US".equals(locale)) {
                return "en-US,en;q=0.9";
            }
            return locale + ",en;q=0.9,en-US;q=0.8";
        }

        public static GeoProfile getDefault() {
            return new GeoProfile("GB", "Europe/London", "en-GB", new String[]{"en-GB", "en", "en-US"}, 51.5074, -0.1278);
        }

        public static GeoProfile forCountry(String code, String fallbackTz, Double lat, Double lon) {
            if (code == null) return getDefault();
            String c = code.trim().toUpperCase(Locale.ROOT);
            if (!c.matches("[A-Z]{2}")) return getDefault();
            switch (c) {
                case "DE":
                    return new GeoProfile("DE", safeTimeZone(fallbackTz, "Europe/Berlin"), "de-DE", new String[]{"de-DE", "de", "en-US", "en"}, safeCoordinate(lat, -90, 90, 52.5200), safeCoordinate(lon, -180, 180, 13.4050));
                case "US":
                    return new GeoProfile("US", safeTimeZone(fallbackTz, "America/New_York"), "en-US", new String[]{"en-US", "en"}, safeCoordinate(lat, -90, 90, 40.7128), safeCoordinate(lon, -180, 180, -74.0060));
                case "GB":
                case "UK":
                    return new GeoProfile("GB", safeTimeZone(fallbackTz, "Europe/London"), "en-GB", new String[]{"en-GB", "en", "en-US"}, safeCoordinate(lat, -90, 90, 51.5074), safeCoordinate(lon, -180, 180, -0.1278));
                case "FR":
                    return new GeoProfile("FR", safeTimeZone(fallbackTz, "Europe/Paris"), "fr-FR", new String[]{"fr-FR", "fr", "en-US", "en"}, safeCoordinate(lat, -90, 90, 48.8566), safeCoordinate(lon, -180, 180, 2.3522));
                case "NL":
                    return new GeoProfile("NL", safeTimeZone(fallbackTz, "Europe/Amsterdam"), "nl-NL", new String[]{"nl-NL", "nl", "en-US", "en"}, safeCoordinate(lat, -90, 90, 52.3676), safeCoordinate(lon, -180, 180, 4.9041));
                case "SE":
                    return new GeoProfile("SE", safeTimeZone(fallbackTz, "Europe/Stockholm"), "sv-SE", new String[]{"sv-SE", "sv", "en-US", "en"}, safeCoordinate(lat, -90, 90, 59.3293), safeCoordinate(lon, -180, 180, 18.0686));
                case "CH":
                    return new GeoProfile("CH", safeTimeZone(fallbackTz, "Europe/Zurich"), "de-CH", new String[]{"de-CH", "de", "en-US", "en"}, safeCoordinate(lat, -90, 90, 47.3769), safeCoordinate(lon, -180, 180, 8.5417));
                case "AT":
                    return new GeoProfile("AT", safeTimeZone(fallbackTz, "Europe/Vienna"), "de-AT", new String[]{"de-AT", "de", "en-US", "en"}, safeCoordinate(lat, -90, 90, 48.2082), safeCoordinate(lon, -180, 180, 16.3738));
                case "PL":
                    return new GeoProfile("PL", safeTimeZone(fallbackTz, "Europe/Warsaw"), "pl-PL", new String[]{"pl-PL", "pl", "en-US", "en"}, safeCoordinate(lat, -90, 90, 52.2297), safeCoordinate(lon, -180, 180, 21.0122));
                case "ES":
                    return new GeoProfile("ES", safeTimeZone(fallbackTz, "Europe/Madrid"), "es-ES", new String[]{"es-ES", "es", "en-US", "en"}, safeCoordinate(lat, -90, 90, 40.4168), safeCoordinate(lon, -180, 180, -3.7038));
                case "IT":
                    return new GeoProfile("IT", safeTimeZone(fallbackTz, "Europe/Rome"), "it-IT", new String[]{"it-IT", "it", "en-US", "en"}, safeCoordinate(lat, -90, 90, 41.9028), safeCoordinate(lon, -180, 180, 12.4964));
                case "CA":
                    return new GeoProfile("CA", safeTimeZone(fallbackTz, "America/Toronto"), "en-CA", new String[]{"en-CA", "en", "en-US"}, safeCoordinate(lat, -90, 90, 43.6532), safeCoordinate(lon, -180, 180, -79.3832));
                case "AU":
                    return new GeoProfile("AU", safeTimeZone(fallbackTz, "Australia/Sydney"), "en-AU", new String[]{"en-AU", "en", "en-US"}, safeCoordinate(lat, -90, 90, -33.8688), safeCoordinate(lon, -180, 180, 151.2093));
                case "JP":
                    return new GeoProfile("JP", safeTimeZone(fallbackTz, "Asia/Tokyo"), "ja-JP", new String[]{"ja-JP", "ja", "en-US", "en"}, safeCoordinate(lat, -90, 90, 35.6762), safeCoordinate(lon, -180, 180, 139.6503));
                case "FI":
                    return new GeoProfile("FI", safeTimeZone(fallbackTz, "Europe/Helsinki"), "fi-FI", new String[]{"fi-FI", "fi", "en-US", "en"}, safeCoordinate(lat, -90, 90, 60.1699), safeCoordinate(lon, -180, 180, 24.9384));
                case "NO":
                    return new GeoProfile("NO", safeTimeZone(fallbackTz, "Europe/Oslo"), "nb-NO", new String[]{"nb-NO", "no", "en-US", "en"}, safeCoordinate(lat, -90, 90, 59.9139), safeCoordinate(lon, -180, 180, 10.7522));
                default:
                    String tz = safeTimeZone(fallbackTz, "UTC");
                    double la = safeCoordinate(lat, -90, 90, 51.5074);
                    double lo = safeCoordinate(lon, -180, 180, -0.1278);
                    return new GeoProfile(c, tz, "en-US", new String[]{"en-US", "en"}, la, lo);
            }
        }

        private static String safeTimeZone(String candidate, String fallback) {
            if (candidate == null || candidate.trim().isEmpty()) return fallback;
            String value = candidate.trim();
            TimeZone parsed = TimeZone.getTimeZone(value);
            if ("GMT".equals(parsed.getID()) && !"GMT".equalsIgnoreCase(value)) return fallback;
            return value;
        }

        private static double safeCoordinate(Double value, double minimum, double maximum, double fallback) {
            if (value == null || value.isNaN() || value.isInfinite() || value < minimum || value > maximum) {
                return fallback;
            }
            return value;
        }
    }

    private String buildSpoofJs(GeoProfile profile) {
        if (profile == null) profile = GeoProfile.getDefault();
        JSONArray langsJson = new JSONArray();
        for (String language : profile.languages) langsJson.put(language);

        return "(function() {" +
            "  try {" +
            "    const TARGET_TIMEZONE = " + JSONObject.quote(profile.timeZone) + ";" +
            "    const TARGET_LOCALE = " + JSONObject.quote(profile.locale) + ";" +
            "    const TARGET_LANGS = Object.freeze(" + langsJson + ");" +
            "    const SPOOF_COORDS = { latitude: " + profile.latitude + ", longitude: " + profile.longitude + ", accuracy: 15, altitude: null, altitudeAccuracy: null, heading: null, speed: null };" +
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
    }

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
                view.evaluateJavascript(buildSpoofJs(currentGeoProfile), null);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                logTerminal("Page loaded: " + url);
                view.evaluateJavascript(buildSpoofJs(currentGeoProfile), null);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request != null && request.getUrl() != null) {
                    String url = request.getUrl().toString();
                    String currentLocale = (currentGeoProfile != null) ? currentGeoProfile.locale : "en-US";
                    if (url.contains("hl=ru") || (url.contains("gemini.google.com") && !url.contains("hl="))) {
                        if (url.contains("hl=")) {
                            url = url.replaceAll("hl=[^&]+", "hl=" + currentLocale);
                        } else {
                            url = url + (url.contains("?") ? "&hl=" + currentLocale : "?hl=" + currentLocale);
                        }
                        Map<String, String> headers = new HashMap<>();
                        headers.put("Accept-Language", (currentGeoProfile != null) ? currentGeoProfile.getAcceptLanguageHeader() : "en-US,en;q=0.9");
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

    private void resolveGeoProfileAsync(int localPort, String proxyKey, int generation) {
        backgroundExecutor.submit(() -> {
            Proxy proxy = new Proxy(Proxy.Type.HTTP, new InetSocketAddress("127.0.0.1", localPort));
            GeoProfile detectedProfile = null;
            String provider = null;

            try {
                detectedProfile = resolveGeoWithIpWho(proxy);
                provider = "ipwho.is";
            } catch (Exception primaryError) {
                Log.d(TAG, "Primary GeoIP failed: " + primaryError.getMessage());
                try {
                    detectedProfile = resolveGeoWithCloudflare(proxy);
                    provider = "Cloudflare Trace";
                } catch (Exception fallbackError) {
                    Log.d(TAG, "Fallback GeoIP failed: " + fallbackError.getMessage());
                }
            }

            if (proxyGeneration.get() != generation) return;
            if (detectedProfile == null) {
                logTerminal("WARN: Proxy country was not detected; SOCKS5 routing stays active with cached/default geo profile.");
                return;
            }

            currentGeoProfile = detectedProfile;
            try {
                JSONObject cached = new JSONObject();
                cached.put("countryCode", detectedProfile.countryCode);
                cached.put("timezone", detectedProfile.timeZone);
                cached.put("lat", detectedProfile.latitude);
                cached.put("lon", detectedProfile.longitude);
                prefs.edit().putString("geo_cache_" + proxyKey, cached.toString()).apply();
            } catch (Exception cacheError) {
                Log.w(TAG, "Cannot cache the detected proxy geo profile.", cacheError);
            }

            GeoProfile finalProfile = detectedProfile;
            logTerminal("Auto-detected proxy geo via " + provider + ": " + finalProfile.countryCode + " (" + finalProfile.timeZone + ", " + finalProfile.locale + ")");
            runOnUiThread(() -> {
                if (proxyGeneration.get() == generation && webView != null && !isFinishing()) {
                    String currentUrl = webView.getUrl();
                    webView.evaluateJavascript(buildSpoofJs(finalProfile), null);
                    if (currentUrl == null || currentUrl.contains("gemini.google.com")) {
                        loadInitialUrl();
                    }
                }
            });
        });
    }

    private GeoProfile resolveGeoWithIpWho(Proxy proxy) throws Exception {
        String response = readGeoResponse(
                new URL("https://ipwho.is/?fields=success,country_code,timezone,latitude,longitude"),
                proxy
        );
        JSONObject json = new JSONObject(response);
        if (!json.optBoolean("success", false)) throw new IOException("ipwho.is returned an unsuccessful response.");

        String countryCode = json.optString("country_code", null);
        if (countryCode == null || !countryCode.matches("[A-Za-z]{2}")) {
            throw new IOException("ipwho.is did not return a country code.");
        }
        JSONObject timezoneObject = json.optJSONObject("timezone");
        String timezone = timezoneObject != null ? timezoneObject.optString("id", null) : null;
        return GeoProfile.forCountry(
                countryCode,
                timezone,
                json.has("latitude") ? json.optDouble("latitude") : null,
                json.has("longitude") ? json.optDouble("longitude") : null
        );
    }

    private GeoProfile resolveGeoWithCloudflare(Proxy proxy) throws Exception {
        String response = readGeoResponse(new URL("https://www.cloudflare.com/cdn-cgi/trace"), proxy);
        String countryCode = null;
        for (String line : response.split("\\r?\\n")) {
            if (line.startsWith("loc=")) {
                countryCode = line.substring(4).trim();
                break;
            }
        }
        if (countryCode == null || !countryCode.matches("[A-Za-z]{2}")) {
            throw new IOException("Cloudflare Trace did not return a country code.");
        }
        return GeoProfile.forCountry(countryCode, null, null, null);
    }

    private String readGeoResponse(URL url, Proxy proxy) throws Exception {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) url.openConnection(proxy);
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setRequestProperty("User-Agent", "geminUp/2.0");
            int status = conn.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                throw new IOException(url.getHost() + " returned HTTP " + status + ".");
            }

            StringBuilder response = new StringBuilder();
            try (InputStream input = conn.getInputStream()) {
                byte[] buffer = new byte[4096];
                int length;
                while ((length = input.read(buffer)) != -1) {
                    response.append(new String(buffer, 0, length, StandardCharsets.UTF_8));
                    if (response.length() > 16384) throw new IOException("GeoIP response is too large.");
                }
            }
            return response.toString();
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void applyConfiguredProxyAndLoad() {
        int generation = proxyGeneration.incrementAndGet();
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
                String proxyKey = safeProxyKey(proxyStr);

                // Load cached GeoProfile if exists
                String cachedGeo = prefs.getString("geo_cache_" + proxyKey, "");
                if (!cachedGeo.isEmpty()) {
                    try {
                        JSONObject obj = new JSONObject(cachedGeo);
                        currentGeoProfile = GeoProfile.forCountry(
                                obj.optString("countryCode", "GB"),
                                obj.optString("timezone", "Europe/London"),
                                obj.optDouble("lat", 51.5074),
                                obj.optDouble("lon", -0.1278)
                        );
                        logTerminal("Cached geo profile: " + currentGeoProfile.countryCode + " (" + currentGeoProfile.timeZone + ")");
                    } catch (Exception ignored) {}
                }

                localBridge = new LocalHttpToSocksBridge(parsed.host, parsed.port, parsed.user, parsed.pass);
                localBridge.start();
                int localPort = localBridge.getLocalPort();
                logTerminal("Local Bridge active on 127.0.0.1:" + localPort + " -> SOCKS5 " + parsed.host + ":" + parsed.port);

                resolveGeoProfileAsync(localPort, proxyKey, generation);

                if (WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
                    String proxyUrl = "http://127.0.0.1:" + localPort;
                    ProxyConfig proxyConfig = new ProxyConfig.Builder()
                            .addProxyRule(proxyUrl)
                            .build();
                    ProxyController.getInstance().setProxyOverride(proxyConfig, backgroundExecutor, () -> {
                        runOnUiThread(() -> {
                            if (proxyGeneration.get() != generation || isFinishing()) return;
                            logTerminal("Proxy override set successfully (Fail-Closed active).");
                            loadInitialUrl();
                        });
                    });
                    return;
                } else {
                    proxyGeneration.compareAndSet(generation, generation + 1);
                    if (localBridge != null) {
                        localBridge.stop();
                        localBridge = null;
                    }
                    logTerminal("WARN: PROXY_OVERRIDE not supported by system WebView.");
                    showBlockedPage("Системный WebView не поддерживает безопасную маршрутизацию через SOCKS5.");
                    return;
                }
            } catch (Exception e) {
                proxyGeneration.compareAndSet(generation, generation + 1);
                logTerminal("ERROR: " + e.getMessage());
                Toast.makeText(this, "Proxy error: " + e.getMessage(), Toast.LENGTH_LONG).show();
                if (localBridge != null) {
                    localBridge.stop();
                    localBridge = null;
                }
                showBlockedPage("SOCKS5 недоступен. Прямое подключение заблокировано.");
                return;
            }
        } else if (!isEnabled) {
            currentGeoProfile = GeoProfile.getDefault();
            if (WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
                ProxyController.getInstance().clearProxyOverride(backgroundExecutor, () -> {
                    runOnUiThread(() -> {
                        if (proxyGeneration.get() != generation || isFinishing()) return;
                        logTerminal("Proxy override cleared (Direct Connection).");
                        loadInitialUrl();
                    });
                });
                return;
            }
        } else {
            logTerminal("WARN: Proxy is enabled but its configuration is invalid; direct connection is blocked.");
            showBlockedPage("Укажи корректный SOCKS5. Прямое подключение заблокировано.");
            return;
        }
        loadInitialUrl();
    }

    private void showBlockedPage(String reason) {
        String html = "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">" +
                "<body style=\"margin:0;background:#050805;color:#55ff77;font:16px monospace;display:flex;min-height:100vh;align-items:center;justify-content:center\">" +
                "<main style=\"max-width:680px;padding:32px\"><h1>geminUp: FAIL-CLOSED</h1><p>" +
                android.text.Html.escapeHtml(reason) +
                "</p><p>Трафик Gemini не был отправлен напрямую.</p></main></body>";
        webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    private void loadInitialUrl() {
        Map<String, String> extraHeaders = new HashMap<>();
        extraHeaders.put("Accept-Language", currentGeoProfile.getAcceptLanguageHeader());
        String url = "https://gemini.google.com/?hl=" + currentGeoProfile.locale;
        logTerminal("Connecting to " + url + " [" + currentGeoProfile.countryCode + "]");
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

    private static String safeProxyKey(String raw) {
        ProxyConfigHolder parsed = parseProxy(raw);
        if (parsed == null || !parsed.isValid()) return "default";
        return parsed.host.replaceAll("[^a-zA-Z0-9.-]", "_") + "_" + parsed.port;
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
        proxyGeneration.incrementAndGet();
        if (localBridge != null) {
            localBridge.stop();
        }
        backgroundExecutor.shutdownNow();
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

        private static Socket connectAndHandshakeSocks(String socksHost, int socksPort, String socksUser, String socksPass, String targetHost, int targetPort, int timeoutMs) throws Exception {
            Socket upstream = new Socket();
            upstream.setTcpNoDelay(true);
            upstream.setKeepAlive(true);
            upstream.connect(new InetSocketAddress(socksHost, socksPort), timeoutMs);
            upstream.setSoTimeout(30000);

            InputStream sIn = upstream.getInputStream();
            OutputStream sOut = upstream.getOutputStream();

            boolean hasAuth = (socksUser != null && !socksUser.isEmpty());
            if (hasAuth) {
                sOut.write(new byte[]{0x05, 0x02, 0x00, 0x02});
            } else {
                sOut.write(new byte[]{0x05, 0x01, 0x00});
            }
            sOut.flush();

            int sVer = sIn.read();
            int sMethod = sIn.read();
            if (sVer != 0x05) throw new IOException("Invalid SOCKS5 version: " + sVer);

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
                if (aStatus != 0x00) throw new IOException("SOCKS5 Auth failed status: " + aStatus);
            } else if (sMethod != 0x00) {
                throw new IOException("SOCKS5 Unsupported auth method: " + sMethod);
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
            sIn.read(); // Reserved byte
            int cAtyp = sIn.read();
            if (cRep != 0x00) throw new IOException("SOCKS5 Connect rejected with code: " + cRep);

            if (cAtyp == 0x01) {
                byte[] ip = new byte[4];
                int read = 0;
                while (read < 4) { int r = sIn.read(ip, read, 4 - read); if (r == -1) break; read += r; }
            } else if (cAtyp == 0x03) {
                int dLen = sIn.read();
                byte[] d = new byte[dLen];
                int read = 0;
                while (read < dLen) { int r = sIn.read(d, read, dLen - read); if (r == -1) break; read += r; }
            } else if (cAtyp == 0x04) {
                byte[] ip6 = new byte[16];
                int read = 0;
                while (read < 16) { int r = sIn.read(ip6, read, 16 - read); if (r == -1) break; read += r; }
            }
            sIn.read(); // port byte 1
            sIn.read(); // port byte 2

            return upstream;
        }

        private void handleClient(Socket client) {
            Socket upstreamSocks = null;
            try {
                client.setTcpNoDelay(true);
                client.setKeepAlive(true);
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

                int maxRetries = 3;
                Exception lastError = null;
                for (int attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        upstreamSocks = connectAndHandshakeSocks(socksHost, socksPort, socksUser, socksPass, targetHost, targetPort, 8000);
                        lastError = null;
                        break;
                    } catch (Exception e) {
                        lastError = e;
                        if (upstreamSocks != null) {
                            try { upstreamSocks.close(); } catch (Exception ignored) {}
                            upstreamSocks = null;
                        }
                        if (attempt < maxRetries) {
                            try {
                                Thread.sleep(200L * attempt);
                            } catch (InterruptedException ie) {
                                break;
                            }
                        }
                    }
                }

                if (upstreamSocks == null) {
                    Log.w(TAG, "Failed upstream SOCKS5 connection to " + targetHost + ":" + targetPort + " after " + maxRetries + " attempts: " + (lastError != null ? lastError.getMessage() : "unknown"));
                    byte[] errBody = ("HTTP/1.1 502 Bad Gateway\r\n" +
                            "Content-Type: text/plain; charset=utf-8\r\n" +
                            "Connection: close\r\n\r\n" +
                            "geminUp: SOCKS5 upstream connection failed after retries.\r\n").getBytes(StandardCharsets.UTF_8);
                    out.write(errBody);
                    out.flush();
                    client.close();
                    return;
                }

                InputStream sIn = upstreamSocks.getInputStream();
                OutputStream sOut = upstreamSocks.getOutputStream();

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
                Log.w(TAG, "Local bridge client handler error.", e);
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
