package com.activetogether.companion

import android.app.Activity
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** Shown by Health Connect when someone asks why this app wants access (the privacy explanation). */
class HealthPermissionsRationaleActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = TextView(this).apply {
            text = "Active Together Companion reads your exercise sessions from the last 30 days and, if you allow it, " +
                "the distance recorded during them. For each session it uploads only the activity type, date, " +
                "whole minutes, distance, and start/finish time to the challenge you choose at $SERVER_URL. " +
                "It never reads or uploads routes, heart rate, calories or any other health data."
            textSize = 18f
            setPadding(32, 32, 32, 32)
        }
        val root = ScrollView(this).apply { addView(text) }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
    }
}
