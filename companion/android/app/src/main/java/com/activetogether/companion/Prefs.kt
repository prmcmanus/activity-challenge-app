package com.activetogether.companion

import android.content.Context

/** Session and settings, in plain SharedPreferences (as before - see the README's production notes). */
class Prefs(context: Context) {
    private val p = context.applicationContext.getSharedPreferences("active-together", Context.MODE_PRIVATE)

    var token: String?
        get() = p.getString("token", null)?.takeIf { it.isNotBlank() }
        set(v) = p.edit().putString("token", v).apply()
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

    fun signOut() = p.edit().remove("token").apply()
}
