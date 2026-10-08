package com.activetogether.companion

import android.app.Activity
import android.os.Bundle
import android.text.method.LinkMovementMethod
import androidx.core.text.HtmlCompat
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** Shown by Health Connect when someone asks why this app wants access (the privacy explanation). */
class HealthPermissionsRationaleActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Health Connect shows this when someone asks why the app wants access; Play requires it to
        // explain the use and link the privacy policy.
        val text = TextView(this).apply {
            text = HtmlCompat.fromHtml(
                "Active Together reads your exercise sessions, the distance recorded during them, and your daily step count. " +
                "For each workout it uploads only the activity type, date, start and finish time, whole minutes and distance, " +
                "and for each day your step total, to the challenges you choose at $SERVER_URL. " +
                "If you switch on \"Include GPS routes\", it also uploads each workout's route so you can see it on a map; " +
                "only you can see your routes. It never reads or uploads heart rate, calories or any other health data, " +
                "and your health data is never used for advertising or sold.<br><br>" +
                "<a href=\"$SERVER_URL/privacy.html\">Privacy policy</a>",
                HtmlCompat.FROM_HTML_MODE_COMPACT)
            movementMethod = LinkMovementMethod.getInstance()
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
