package com.activetogether.companion

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.activetogether.companion.ui.ActiveTogetherTheme
import com.activetogether.companion.ui.AppRoot
import com.activetogether.companion.ui.AppViewModel

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Targeting Android 15 is edge-to-edge anyway; Scaffold and the screens pad for the bars.
        enableEdgeToEdge()
        // Keep the background schedule in step with the setting (e.g. after an app update).
        if (vm.prefs.autoSync && vm.prefs.token != null) SyncWorker.schedule(this, vm.prefs.autoSyncHours)
        if (savedInstanceState == null) { vm.openLink(intent?.data); vm.openPushUrl(intent?.getStringExtra("url")) }
        setContent { ActiveTogetherTheme { AppRoot(vm) } }
    }

    /** An invite link tapped while the app is already open. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        vm.openLink(intent.data)
        vm.openPushUrl(intent.getStringExtra("url"))
    }
}
