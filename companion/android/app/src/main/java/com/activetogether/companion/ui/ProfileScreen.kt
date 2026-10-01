package com.activetogether.companion.ui

import android.Manifest
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.health.connect.client.PermissionController
import com.activetogether.companion.SERVER_URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

/** Shrink a picked photo to a 320px JPEG data: URL - the same size the web app sends for avatars. */
private fun avatarDataUrl(context: Context, uri: Uri): String {
    val src = context.contentResolver.openInputStream(uri).use { BitmapFactory.decodeStream(it) } ?: error("Couldn't read that image")
    val scale = 320f / maxOf(src.width, src.height)
    val bmp = if (scale < 1f) Bitmap.createScaledBitmap(src, (src.width * scale).toInt(), (src.height * scale).toInt(), true) else src
    val out = ByteArrayOutputStream()
    bmp.compress(Bitmap.CompressFormat.JPEG, 85, out)
    return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
}

@Composable
private fun SettingRow(title: String, note: String, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable(enabled) { onChange(!checked) }) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(note, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked, onChange, enabled = enabled)
    }
}

@Composable
fun ProfileScreen(vm: AppViewModel) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val me = vm.me
    var name by remember(me) { mutableStateOf(me?.name.orEmpty()) }
    var email by remember(me) { mutableStateOf(me?.email.orEmpty()) }
    var newPassword by remember { mutableStateOf("") }
    var currentPassword by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    var avatarBusy by remember { mutableStateOf(false) }

    var autoSync by remember { mutableStateOf(vm.prefs.autoSync) }
    var hours by remember { mutableStateOf(vm.prefs.autoSyncHours) }
    var routes by remember { mutableStateOf(vm.prefs.includeRoutes) }
    var unit by remember { mutableStateOf(vm.prefs.preferredUnit) }
    var backgroundGranted by remember { mutableStateOf(false) }
    val backgroundSupported = remember { runCatching { vm.health.backgroundReadSupported() }.getOrDefault(false) }
    LaunchedEffect(Unit) { backgroundGranted = runCatching { vm.health.backgroundPermission in vm.health.grantedPermissions() }.getOrDefault(false) }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        avatarBusy = true
        scope.launch {
            val dataUrl = runCatching { withContext(Dispatchers.Default) { avatarDataUrl(context, uri) } }.getOrElse { vm.message = it.message; avatarBusy = false; return@launch }
            val url = vm.call { it.uploadImage(dataUrl) }
            val updated = url?.let { u -> vm.call { it.updateProfile(null, null, null, null, u) } }
            updated?.let { vm.updateMe(it); vm.message = "Photo updated" }
            avatarBusy = false
        }
    }
    val notifyLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    // Android shows one permission dialog at a time, so notifications are asked for once the
    // background-access answer is in.
    fun askNotifications() { if (Build.VERSION.SDK_INT >= 33) notifyLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) }
    val bgLauncher = rememberLauncherForActivityResult(PermissionController.createRequestPermissionResultContract()) { granted ->
        backgroundGranted = vm.health.backgroundPermission in granted
        askNotifications()
    }

    Column(Modifier.verticalScroll(rememberScrollState()).padding(PagePadding), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Hero("My account", me?.name ?: "", trailing = {
            Box(contentAlignment = Alignment.Center, modifier = Modifier.clickable { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }) {
                Avatar(me?.avatarUrl, me?.name ?: "?", size = 72.dp)
                if (avatarBusy) CircularProgressIndicator(Modifier.size(72.dp))
            }
        }, below = { Text(me?.email.orEmpty(), color = androidx.compose.ui.graphics.Color.White.copy(alpha = 0.9f)) })

        SectionCard("Profile") {
            OutlinedButton(onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }) {
                Icon(Icons.Default.PhotoCamera, null); Spacer(Modifier.width(8.dp)); Text("Change photo")
            }
            OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
            OutlinedTextField(newPassword, { newPassword = it }, label = { Text("New password (leave blank to keep)") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
            val sensitive = newPassword.isNotEmpty() || (me != null && email.trim().lowercase() != me.email)
            if (sensitive) {
                OutlinedTextField(currentPassword, { currentPassword = it }, label = { Text("Current password") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    supportingText = { Text("Needed to change your email or password") })
            }
            note?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(enabled = !busy && name.isNotBlank() && email.isNotBlank() && (!sensitive || currentPassword.isNotEmpty()), onClick = {
                busy = true; note = null
                scope.launch {
                    val updated = vm.call { it.updateProfile(name.trim(), email.trim().takeIf { e -> e.lowercase() != me?.email }, currentPassword, newPassword, null) }
                    if (updated != null) {
                        vm.updateMe(updated); vm.prefs.email = updated.email
                        newPassword = ""; currentPassword = ""; vm.message = "Profile saved"
                    } else { note = vm.message; vm.message = null }
                    busy = false
                }
            }) { Text("Save profile") }
        }

        SectionCard("Sync settings") {
            SettingRow("Sync automatically",
                if (backgroundSupported) "New workouts go into every challenge they fit, every few hours and when you open the app. Workouts with no distance skip distance challenges."
                else "New workouts sync each time you open the app. (This phone's Health Connect can't read in the background.)",
                autoSync) { on ->
                autoSync = on
                vm.setAutoSync(on, hours)
                if (on) {
                    if (backgroundSupported && !backgroundGranted) bgLauncher.launch(setOf(vm.health.backgroundPermission)) else askNotifications()
                    vm.autoSyncNow()
                }
            }
            if (autoSync && backgroundSupported) {
                Dropdown("How often", listOf(1, 3, 6, 12, 24), hours, { if (it == 1) "Every hour" else "Every $it hours" }, { h -> hours = h; vm.setAutoSync(true, h) })
                if (!backgroundGranted) {
                    Text("Health Connect hasn't allowed background reading yet, so it will only sync when the app is open.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    OutlinedButton(onClick = { bgLauncher.launch(setOf(vm.health.backgroundPermission)) }) { Text("Allow background access") }
                }
            }
            SettingRow("Include GPS routes",
                "Upload each workout's route so you can see it on a map. Only you can see your routes. Routes recorded by other apps need a tap per workout in Sync.",
                routes) { on -> routes = on; vm.prefs.includeRoutes = on }
            Dropdown("Distance unit I type in", listOf("mi", "km"), unit, { if (it == "km") "Kilometres" else "Miles" }, { u -> unit = u; vm.prefs.preferredUnit = u })
        }

        OutlinedButton(onClick = { vm.signOut() }, modifier = Modifier.fillMaxWidth()) {
            Icon(Icons.AutoMirrored.Filled.Logout, null); Spacer(Modifier.width(8.dp)); Text("Sign out")
        }
        Text("Active Together · ${SERVER_URL.removePrefix("https://")} · version ${context.packageManager.getPackageInfo(context.packageName, 0).versionName}",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
