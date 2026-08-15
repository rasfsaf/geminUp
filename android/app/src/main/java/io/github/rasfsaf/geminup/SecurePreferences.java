package io.github.rasfsaf.geminup;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecurePreferences {
    private static final String TAG = "geminUp";
    private static final String PREFERENCES_NAME = "GeminUpSecurePrefsV1";
    private static final String KEY_ALIAS = "geminup_preferences_key_v1";
    private static final String ANDROID_KEY_STORE = "AndroidKeyStore";
    private static final byte FORMAT_VERSION = 1;

    private final SharedPreferences preferences;

    SecurePreferences(Context context) {
        preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
        getOrCreateKey();
    }

    String getString(String key, String defaultValue) {
        String encoded = preferences.getString(key, null);
        if (encoded == null) return defaultValue;
        try {
            return decrypt(key, encoded);
        } catch (Exception error) {
            Log.e(TAG, "Encrypted preference is damaged and will be removed: " + key, error);
            preferences.edit().remove(key).apply();
            return defaultValue;
        }
    }

    boolean getBoolean(String key, boolean defaultValue) {
        return preferences.getBoolean(key, defaultValue);
    }

    Editor edit() {
        return new Editor(preferences.edit());
    }

    final class Editor {
        private final SharedPreferences.Editor editor;

        private Editor(SharedPreferences.Editor value) {
            editor = value;
        }

        Editor putString(String key, String value) {
            editor.putString(key, encrypt(key, value));
            return this;
        }

        Editor putBoolean(String key, boolean value) {
            editor.putBoolean(key, value);
            return this;
        }

        Editor remove(String key) {
            editor.remove(key);
            return this;
        }

        void apply() {
            editor.apply();
        }
    }

    private static String encrypt(String preferenceKey, String value) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            cipher.updateAAD(preferenceKey.getBytes(StandardCharsets.UTF_8));
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] iv = cipher.getIV();
            ByteBuffer payload = ByteBuffer.allocate(2 + iv.length + encrypted.length);
            payload.put(FORMAT_VERSION);
            payload.put((byte) iv.length);
            payload.put(iv);
            payload.put(encrypted);
            return Base64.encodeToString(payload.array(), Base64.NO_WRAP);
        } catch (Exception error) {
            throw new IllegalStateException("Cannot encrypt the local proxy configuration.", error);
        }
    }

    private static String decrypt(String preferenceKey, String encoded) throws Exception {
        byte[] payload = Base64.decode(encoded, Base64.NO_WRAP);
        ByteBuffer buffer = ByteBuffer.wrap(payload);
        if (buffer.remaining() < 3 || buffer.get() != FORMAT_VERSION) {
            throw new IllegalArgumentException("Unknown encrypted preference format.");
        }
        int ivLength = Byte.toUnsignedInt(buffer.get());
        if (ivLength < 12 || ivLength > 16 || buffer.remaining() <= ivLength) {
            throw new IllegalArgumentException("Invalid encrypted preference payload.");
        }
        byte[] iv = new byte[ivLength];
        buffer.get(iv);
        byte[] encrypted = new byte[buffer.remaining()];
        buffer.get(encrypted);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
        cipher.updateAAD(preferenceKey.getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
    }

    private static synchronized SecretKey getOrCreateKey() {
        try {
            KeyStore keyStore = KeyStore.getInstance(ANDROID_KEY_STORE);
            keyStore.load(null);
            if (keyStore.containsAlias(KEY_ALIAS)) {
                return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
            }
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE);
            generator.init(new KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build());
            return generator.generateKey();
        } catch (Exception error) {
            throw new IllegalStateException("Android Keystore is unavailable.", error);
        }
    }
}
