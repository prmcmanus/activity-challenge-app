package com.activetogether.companion

import android.app.Activity
import android.os.Bundle
import android.widget.TextView

class HealthPermissionsRationaleActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(TextView(this).apply {
            text = "Active Together reads exercise sessions only, converts them to whole active minutes, and uploads duration summaries to your selected team challenge."
            textSize = 18f
            setPadding(32, 32, 32, 32)
        })
    }
}
