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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.automirrored.filled.HelpOutline
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.health.connect.client.PermissionController
import com.activetogether.companion.Profile
import com.activetogether.companion.SERVER_URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.time.LocalDate

/** The three sharing levels, as offered on the edit screen and the web's My account. */
val SHARING_LEVELS = listOf(
    Triple("private", "Private", "Your name and photo only."),
    Triple("summary", "Totals", "Plus your total and rank in each challenge you share."),
    Triple("full", "Full", "Plus your recent activity in those challenges, with comments."),
)
fun sharingLabel(code: String) = SHARING_LEVELS.firstOrNull { it.first == code }?.second ?: "Totals"

private fun ordinal(n: Int) = n.toString() + when { n % 100 in 11..13 -> "th"; n % 10 == 1 -> "st"; n % 10 == 2 -> "nd"; n % 10 == 3 -> "rd"; else -> "th" }

/** A profile: the header, then whatever the person's sharing level shows. Used for anyone, including me. */
fun LazyListScope.profileItems(p: Profile, header: @Composable () -> Unit = {}) {
    item {
        Hero(if (p.memberSince.isNotBlank()) "Member since ${runCatching { LocalDate.parse(p.memberSince).let { "${it.month.name.lowercase().replaceFirstChar(Char::uppercase)} ${it.year}" } }.getOrDefault(p.memberSince)}" else "Profile",
            p.name, trailing = { Avatar(p.avatarUrl, p.name, size = 72.dp) },
            below = { p.bio?.let { Text(it, color = Color.White.copy(alpha = 0.92f), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 6.dp)) } })
    }
    item { header() }
    val challenges = p.challenges
    if (challenges == null) {
        item {
            SectionCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Lock, null, tint = MaterialTheme.colorScheme.onSurfaceVariant); Spacer(Modifier.width(10.dp))
                    EmptyNote(if (p.self) "Your profile is private: people only see your name and photo." else "${p.name.substringBefore(' ')} keeps their profile private.")
                }
            }
        }
        return
    }
    item {
        SectionCard(if (p.self) "My challenges" else "Challenges you share") {
            if (challenges.isEmpty()) EmptyNote("No challenges yet.")
            challenges.forEachIndexed { i, c ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(c.name, style = MaterialTheme.typography.titleMedium)
                        Text(listOfNotNull(c.team, fmtRange(c.startDate, c.endDate)).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text(fmtMeasure(c.measuresDistance, c.minutes, c.distance, c.distanceUnit), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
                        if (c.rank > 0) Text("${ordinal(c.rank)} of ${c.of}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (i < challenges.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        }
    }
    p.activities?.let { acts ->
        item {
            SectionCard("Recent activity") {
                if (acts.isEmpty()) EmptyNote("Nothing logged yet.")
                acts.forEachIndexed { i, a ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(a.type, style = MaterialTheme.typography.titleMedium)
                            Text(listOfNotNull(fmtDay(a.date), a.startTime, a.challengeName).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            a.comment?.let { Text("“$it”", style = MaterialTheme.typography.bodySmall) }
                        }
                        val d = a.distance?.let { "${fmtNum(it)} ${if (a.distanceUnit == "km") "km" else "mi"}" }
                        val m = a.minutes?.let { "${fmtNum(it)} min" }
                        Text((if (a.measuresDistance) listOf(d, m) else listOf(m, d)).filterNotNull().joinToString(" · "), fontWeight = FontWeight.Bold)
                    }
                    if (i < acts.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                }
            }
        }
    }
}

/** Someone else's profile (or mine), opened from a leaderboard. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UserProfileScreen(vm: AppViewModel, userId: Int) {
    val scope = rememberCoroutineScope()
    var profile by remember { mutableStateOf<Profile?>(null) }
    var loading by remember { mutableStateOf(true) }
    var missing by remember { mutableStateOf(false) }
    fun load() = scope.launch {
        loading = true
        val p = vm.call { it.profile(userId) }
        if (p != null) profile = p else missing = profile == null
        loading = false
    }
    LaunchedEffect(userId) { load() }
    PullToRefreshBox(isRefreshing = loading && profile != null, onRefresh = { load() }) {
        val p = profile
        if (p == null) { if (missing) LazyColumn(contentPadding = PagePadding) { item { SectionCard { EmptyNote("This profile isn't available.") } } } else Loading(); return@PullToRefreshBox }
        LazyColumn(contentPadding = PagePadding, verticalArrangement = Arrangement.spacedBy(12.dp)) { profileItems(p) }
    }
}

/** Me: my profile exactly as challenge-mates see it, then settings. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MeScreen(vm: AppViewModel, edit: () -> Unit, help: () -> Unit) {
    val me = vm.me
    val scope = rememberCoroutineScope()
    var profile by remember { mutableStateOf<Profile?>(null) }
    var loading by remember { mutableStateOf(false) }
    fun load() = scope.launch {
        loading = true
        vm.refreshMe()
        me?.let { m -> vm.call { it.profile(m.id) }?.let { profile = it } }
        loading = false
    }
    LaunchedEffect(me?.id, me?.name, me?.avatarUrl, me?.bio, me?.sharing) { if (me != null) load() }

    PullToRefreshBox(isRefreshing = loading, onRefresh = { load() }) {
        LazyColumn(contentPadding = PagePadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val p = profile
            if (p == null) item { Loading() } else profileItems(p) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Default.Visibility, null, tint = MaterialTheme.colorScheme.onSurfaceVariant); Spacer(Modifier.width(8.dp))
                    Text("How people in your challenges see you · sharing: ${sharingLabel(me?.sharing ?: "summary")}",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                    Button(onClick = edit) { Icon(Icons.Default.Edit, null); Spacer(Modifier.width(6.dp)); Text("Edit") }
                }
            }
            item { SyncSettingsCard(vm) }
            item {
                OutlinedButton(onClick = help, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.AutoMirrored.Filled.HelpOutline, null); Spacer(Modifier.width(8.dp))
                    Text("Help & feedback" + if (vm.helpBadge > 0) " (${vm.helpBadge} new)" else "")
                }
            }
            item {
                OutlinedButton(onClick = { vm.signOut() }, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.AutoMirrored.Filled.Logout, null); Spacer(Modifier.width(8.dp)); Text("Sign out")
                }
            }
            item { VersionLine() }
        }
    }
}

@Composable
private fun VersionLine() {
    val context = LocalContext.current
    Text("Active Together · ${SERVER_URL.removePrefix("https://")} · version ${context.packageManager.getPackageInfo(context.packageName, 0).versionName}",
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

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

/** Edit my profile: photo, name, bio, sharing level, email and password. */
@Composable
fun EditProfileScreen(vm: AppViewModel, done: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val me = vm.me
    var name by remember(me) { mutableStateOf(me?.name.orEmpty()) }
    var bio by remember(me) { mutableStateOf(me?.bio.orEmpty()) }
    var sharing by remember(me) { mutableStateOf(me?.sharing ?: "summary") }
    var email by remember(me) { mutableStateOf(me?.email.orEmpty()) }
    var newPassword by remember { mutableStateOf("") }
    var currentPassword by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    var avatarBusy by remember { mutableStateOf(false) }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        avatarBusy = true
        scope.launch {
            val dataUrl = runCatching { withContext(Dispatchers.Default) { avatarDataUrl(context, uri) } }.getOrElse { vm.message = it.message; avatarBusy = false; return@launch }
            val url = vm.call { it.uploadImage(dataUrl) }
            url?.let { u -> vm.call { it.updateProfile(null, null, null, null, u) } }?.let { vm.updateMe(it); vm.message = "Photo updated" }
            avatarBusy = false
        }
    }

    Column(Modifier.verticalScroll(rememberScrollState()).padding(PagePadding), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionCard("Photo") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(contentAlignment = Alignment.Center) {
                    Avatar(me?.avatarUrl, me?.name ?: "?", size = 72.dp)
                    if (avatarBusy) CircularProgressIndicator(Modifier.size(72.dp))
                }
                Spacer(Modifier.width(16.dp))
                OutlinedButton(onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }) {
                    Icon(Icons.Default.PhotoCamera, null); Spacer(Modifier.width(8.dp)); Text("Change photo")
                }
            }
        }
        SectionCard("About you") {
            OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(bio, { bio = it.take(280) }, label = { Text("About me (optional)") }, modifier = Modifier.fillMaxWidth(),
                supportingText = { Text("${bio.length}/280") })
        }
        SectionCard("Who sees what") {
            Text("Only people in a challenge with you can open your profile, and only for challenges you share. Leaderboard totals are always visible to them; GPS routes never are.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            SHARING_LEVELS.forEach { (code, label, desc) ->
                Row(verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth().selectable(selected = sharing == code, role = Role.RadioButton) { sharing = code }) {
                    RadioButton(selected = sharing == code, onClick = null)
                    Spacer(Modifier.width(10.dp))
                    Column {
                        Text(label, style = MaterialTheme.typography.titleMedium)
                        Text(desc, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        SectionCard("Sign-in details") {
            OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
            OutlinedTextField(newPassword, { newPassword = it }, label = { Text("New password (leave blank to keep)") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
        }
        val sensitive = newPassword.isNotEmpty() || (me != null && email.trim().lowercase() != me.email)
        if (sensitive) {
            OutlinedTextField(currentPassword, { currentPassword = it }, label = { Text("Current password") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                supportingText = { Text("Needed to change your email or password") })
        }
        note?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(enabled = !busy && name.isNotBlank() && email.isNotBlank() && (!sensitive || currentPassword.isNotEmpty()), modifier = Modifier.fillMaxWidth(), onClick = {
            busy = true; note = null
            scope.launch {
                val updated = vm.call {
                    it.updateProfile(name.trim(), email.trim().takeIf { e -> e.lowercase() != me?.email }, currentPassword, newPassword, null, bio.trim(), sharing)
                }
                busy = false
                if (updated != null) {
                    vm.updateMe(updated); vm.prefs.email = updated.email
                    vm.message = "Profile saved"; done()
                } else { note = vm.message; vm.message = null }
            }
        }) { Text("Save") }
    }
}

/** Automatic sync, routes and typing unit - on the Me page under the profile. */
@Composable
fun SyncSettingsCard(vm: AppViewModel) {
    var autoSync by remember { mutableStateOf(vm.prefs.autoSync) }
    var hours by remember { mutableStateOf(vm.prefs.autoSyncHours) }
    var routes by remember { mutableStateOf(vm.prefs.includeRoutes) }
    var unit by remember { mutableStateOf(vm.prefs.preferredUnit) }
    var backgroundGranted by remember { mutableStateOf(false) }
    val backgroundSupported = remember { runCatching { vm.health.backgroundReadSupported() }.getOrDefault(false) }
    LaunchedEffect(Unit) { backgroundGranted = runCatching { vm.health.backgroundPermission in vm.health.grantedPermissions() }.getOrDefault(false) }

    val notifyLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    // Android shows one permission dialog at a time, so notifications are asked for once the
    // background-access answer is in.
    fun askNotifications() { if (Build.VERSION.SDK_INT >= 33) notifyLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) }
    val bgLauncher = rememberLauncherForActivityResult(PermissionController.createRequestPermissionResultContract()) { granted ->
        backgroundGranted = vm.health.backgroundPermission in granted
        askNotifications()
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
}
