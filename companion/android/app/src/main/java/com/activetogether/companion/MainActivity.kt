package com.activetogether.companion

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
        setContent { ActiveTogetherTheme { AppRoot(vm) } }
    }
}
