package com.activetogether.companion

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Settings in SharedPreferences; the session token encrypted with a key that never leaves the Android
 * Keystore. A token from an older version (kept in plain text) is moved across the first time it's read.
 */
class Prefs(context: Context) {
    private val p = context.applicationContext.getSharedPreferences("active-together", Context.MODE_PRIVATE)

    var token: String?
        get() {
            p.getString("token", null)?.takeIf { it.isNotBlank() }?.let { plain ->
                TokenVault.encrypt(plain)?.let { p.edit().putString("tokenEnc", it).remove("token").apply() }
                return plain
            }
            return p.getString("tokenEnc", null)?.let { TokenVault.decrypt(it) }?.takeIf { it.isNotBlank() }
        }
        set(v) {
            val e = p.edit().remove("token")
            if (v.isNullOrBlank()) e.remove("tokenEnc") else TokenVault.encrypt(v)?.let { e.putString("tokenEnc", it) } ?: e.putString("token", v)
            e.apply()
        }
    var email: String
        get() = p.getString("email", "").orEmpty()
        set(v) = p.edit().putString("email", v).apply()

    /** Sync without being asked: in the background where the phone allows it, and on opening the app. */
    var autoSync: Boolean
        get() = p.getBoolean("autoSync", false)
        set(v) = p.edit().putBoolean("autoSync", v).apply()
    var autoSyncHours: Int
        get() = p.getInt("autoSyncHours", 6)
        set(v) = p.edit().putInt("autoSyncHours", v).apply()
    /** Upload GPS routes with workouts. Off by default: a route is precise location data. */
    var includeRoutes: Boolean
        get() = p.getBoolean("includeRoutes", false)
        set(v) = p.edit().putBoolean("includeRoutes", v).apply()
    /** Unit offered first when typing a distance; the challenge's own unit wins when there is one. */
    var preferredUnit: String
        get() = p.getString("preferredUnit", "mi") ?: "mi"
        set(v) = p.edit().putString("preferredUnit", v).apply()
    var askedDistance: Boolean
        get() = p.getBoolean("askedDistance", false)
        set(v) = p.edit().putBoolean("askedDistance", v).apply()
    var lastSyncSummary: String
        get() = p.getString("lastSyncSummary", "").orEmpty()
        set(v) = p.edit().putString("lastSyncSummary", v).apply()

    /** An invite link opened before signing in, kept until the person has signed in and decided. */
    var pendingInvite: String?
        get() = p.getString("pendingInvite", null)?.takeIf { it.isNotBlank() }
        set(v) = p.edit().putString("pendingInvite", v).apply()

    fun signOut() = p.edit().remove("token").remove("tokenEnc").apply()
}

/** AES-GCM with a key generated inside the Android Keystore. Null when the key is unusable (say, after a
 *  restore onto another phone), which just means signing in again. */
private object TokenVault {
    private const val ALIAS = "active-together-session"
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        }.generateKey()
    }
    fun encrypt(plain: String): String? = runCatching {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        Base64.encodeToString(c.iv + c.doFinal(plain.toByteArray()), Base64.NO_WRAP)
    }.getOrNull()
    fun decrypt(stored: String): String? = runCatching {
        val b = Base64.decode(stored, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, b, 0, 12)) }
        String(c.doFinal(b, 12, b.size - 12))
    }.getOrNull()
}
