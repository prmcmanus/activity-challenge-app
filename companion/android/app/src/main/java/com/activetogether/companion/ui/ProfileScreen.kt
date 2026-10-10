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
import androidx.compose.foundation.layout.fillMaxSize
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
import androidx.compose.material.icons.filled.AdminPanelSettings
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.TextButton
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
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
import com.activetogether.companion.Person
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

/** A followers or following list; anyone not named is someone I don't share a challenge with. */
@Composable
private fun FollowList(title: String, people: List<Person>, count: Int, openProfile: (Int) -> Unit) {
    Text("$title · $count", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 4.dp))
    if (people.isEmpty() && count == 0) EmptyNote("Nobody yet.")
    people.forEach { x ->
        Row(Modifier.fillMaxWidth().clickable { openProfile(x.id) }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Avatar(x.avatarUrl, x.name, size = 32.dp); Spacer(Modifier.width(10.dp))
            Text(x.name, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
            Icon(Icons.Default.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    if (count > people.size) EmptyNote("+ ${count - people.size} you don't share a challenge with")
}

/** A profile: the header, then followers, then whatever the person's sharing level shows. Used for anyone, including me. */
fun LazyListScope.profileItems(p: Profile, openProfile: (Int) -> Unit = {}, follow: (() -> Unit)? = null, vm: AppViewModel? = null, header: @Composable () -> Unit = {}) {
    item {
        Hero(if (p.memberSince.isNotBlank()) "Member since ${runCatching { LocalDate.parse(p.memberSince).let { "${it.month.name.lowercase().replaceFirstChar(Char::uppercase)} ${it.year}" } }.getOrDefault(p.memberSince)}" else "Profile",
            p.name, trailing = { Avatar(p.avatarUrl, p.name, size = 72.dp) },
            below = { p.bio?.let { Text(it, color = Color.White.copy(alpha = 0.92f), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 6.dp)) } })
    }
    item { header() }
    // Streaks and personal bests.
    p.stats?.let { st ->
        val bits = listOfNotNull(st.streak.takeIf { it > 0 }?.let { "🔥 $it-day streak" }, st.longestStreak.takeIf { it > 1 }?.let { "best run $it days" },
            st.bestMinutes.takeIf { it > 0 }?.let { "longest ${fmtNum(it)} min" }, st.bestMi.takeIf { it > 0 }?.let { "furthest ${fmtNum(it)} mi" },
            st.bestSteps.takeIf { it > 0 }?.let { "most steps ${fmtSteps(it)}" })
        if (bits.isNotEmpty()) item { SectionCard { Text(bits.joinToString(" · "), style = MaterialTheme.typography.titleSmall) } }
    }
    item {
        var tab by remember(p.id) { mutableIntStateOf(0) }
        SectionCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("${p.followersCount} follower${if (p.followersCount == 1) "" else "s"} · ${p.followingCount} following", style = MaterialTheme.typography.titleMedium)
                    if (p.followsYou) Text("Follows you", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                }
                if (follow != null) {
                    if (p.isFollowing) OutlinedButton(onClick = follow) { Icon(Icons.Default.Check, null); Spacer(Modifier.width(6.dp)); Text("Following") }
                    else Button(onClick = follow) { Icon(Icons.Default.PersonAdd, null); Spacer(Modifier.width(6.dp)); Text("Follow") }
                }
            }
            val followers = p.followers; val following = p.following
            if (followers != null && following != null) {
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    SegmentedButton(tab == 0, { tab = 0 }, SegmentedButtonDefaults.itemShape(0, 2)) { Text("Followers") }
                    SegmentedButton(tab == 1, { tab = 1 }, SegmentedButtonDefaults.itemShape(1, 2)) { Text("Following") }
                }
                if (tab == 0) FollowList("Followers", followers, p.followersCount, openProfile)
                else FollowList("Following", following, p.followingCount, openProfile)
            }
        }
    }
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
                        Text(c.name, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.clickable { vm?.openChallenge(c.id) })
                        Text(listOfNotNull(c.team, fmtRange(c.startDate, c.endDate)).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text(fmtMeasure(c.measuresDistance, c.minutes, c.distance, c.distanceUnit, c.measuresSteps, c.steps), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
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
                            Text(listOfNotNull(fmtDay(a.date), a.startTime).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(a.challengeName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.clickable { vm?.openChallenge(a.challengeId) })
                            a.comment?.let { Text("“$it”", style = MaterialTheme.typography.bodySmall) }
                        }
                        val d = a.distance?.let { "${fmtNum(it)} ${if (a.distanceUnit == "km") "km" else "mi"}" }
                        val m = a.minutes?.let { "${fmtNum(it)} min" }
                        Text(a.steps?.takeIf { a.measuresSteps || (a.minutes == null && a.distance == null) }?.let { "${fmtSteps(it)} steps" }
                            ?: (if (a.measuresDistance) listOf(d, m) else listOf(m, d)).filterNotNull().joinToString(" · "), fontWeight = FontWeight.Bold)
                        if (vm != null && !p.self && a.id > 0) { var k by remember(a.id) { mutableStateOf(a.kudos to a.kudosMine) }; KudosButton(vm, a.id, k.first, k.second) { n, mine -> k = n to mine } }
                        else if (a.kudos > 0) Text("  👏 ${a.kudos}", style = MaterialTheme.typography.bodySmall)
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
fun UserProfileScreen(vm: AppViewModel, userId: Int, openProfile: (Int) -> Unit) {
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
    PullToRefreshBox(modifier = Modifier.fillMaxSize(), isRefreshing = loading && profile != null, onRefresh = { load() }) {
        val p = profile
        if (p == null) { if (missing) LazyColumn(Modifier.fillMaxSize(), contentPadding = PagePadding) { item { SectionCard { EmptyNote("This profile isn't available.") } } } else Loading(); return@PullToRefreshBox }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PagePadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            profileItems(p, openProfile, vm = vm, follow = if (p.self) null else ({
                scope.launch { if (vm.call { if (p.isFollowing) it.unfollow(p.id) else it.follow(p.id) } != null) load() }
            }))
        }
    }
}

/** Me: my profile exactly as challenge-mates see it, then settings. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MeScreen(vm: AppViewModel, edit: () -> Unit, help: () -> Unit, admin: () -> Unit, openProfile: (Int) -> Unit) {
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

    PullToRefreshBox(modifier = Modifier.fillMaxSize(), isRefreshing = loading, onRefresh = { load() }) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PagePadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val p = profile
            if (p == null) item { Loading() } else profileItems(p, openProfile, vm = vm) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Default.Visibility, null, tint = MaterialTheme.colorScheme.onSurfaceVariant); Spacer(Modifier.width(8.dp))
                    Text("How people in your challenges see you · sharing: ${sharingLabel(me?.sharing ?: "summary")}",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                    Button(onClick = edit) { Icon(Icons.Default.Edit, null); Spacer(Modifier.width(6.dp)); Text("Edit") }
                }
            }
            if (vm.update != null) item { UpdateBanner(vm) }
            if (vm.me?.adminNeedsTwoFactor == true) item {
                SectionCard {
                    Text("Turn on two-step sign-in to use the admin tools", style = MaterialTheme.typography.titleMedium)
                    Text("Global admins can see and change everything, so signing in needs a code from your phone as well as your password. Set it up on the website: My account, Two-step sign-in.",
                        style = MaterialTheme.typography.bodyMedium)
                }
            }
            item { SyncSettingsCard(vm) }
            if (vm.me?.isAdmin == true) item {
                Button(onClick = admin, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Default.AdminPanelSettings, null); Spacer(Modifier.width(8.dp)); Text("Admin: users and challenges")
                }
            }
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
    Column {
        Text("Active Together · ${SERVER_URL.removePrefix("https://")} · version ${context.packageManager.getPackageInfo(context.packageName, 0).versionName}",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        androidx.compose.material3.TextButton(onClick = { com.activetogether.companion.PolicyActivity.open(context) }) { Text("Privacy policy") }
    }
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
    var deleting by remember { mutableStateOf(false) }

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
        me?.pendingEmail?.let { Text("Changing to $it: open the link we sent there to finish.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        SectionCard("Notifications") {
            SettingRow("Phone notifications", "News about your challenges and tickets on this phone.",
                checked = me?.notifyPush != false) { on -> scope.launch { vm.setNotifyPush(on) } }
            if (me?.notifyPush != false) {
                val kinds = listOf("replies" to "Replies to my tickets", "added" to "Someone adds me to a challenge", "challenge" to "Challenges starting and ending",
                    "weekly" to "My weekly summary", "kudos" to "👏 on my activity") + if (me?.isAdmin == true || me?.adminNeedsTwoFactor == true) listOf("admin" to "New support tickets and server errors") else emptyList()
                kinds.forEach { (k, label) ->
                    SettingRow(label, "", checked = me?.pushPrefs?.get(k) != false) { on -> scope.launch { vm.call { it.setPushPrefs(mapOf(k to on)) }?.let { vm.updateMe(it) } } }
                }
            }
        }
        TwoStepCard(vm)
        PasskeysCard(vm)
        DevicesCard(vm)
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
                    vm.message = if (updated.pendingEmail != null && email.trim().lowercase() != me?.email) "Saved. Open the link we sent to ${updated.pendingEmail} to change your email" else "Profile saved"; done()
                } else { note = vm.message; vm.message = null }
            }
        }) { Text("Save") }
        HorizontalDivider(Modifier.padding(vertical = 8.dp))
        Text("Delete my account", style = MaterialTheme.typography.titleMedium)
        Text("Deletes your account, everything you've logged, your routes, follows and support tickets, straight away. A challenge you own alone passes to its longest-standing member, or is deleted if nobody else is in it. This can't be undone.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedButton(onClick = { deleting = true }, modifier = Modifier.fillMaxWidth()) { Text("Delete my account", color = MaterialTheme.colorScheme.error) }
    }
    if (deleting) {
        var password by remember { mutableStateOf("") }
        var working by remember { mutableStateOf(false) }
        var error by remember { mutableStateOf<String?>(null) }
        AlertDialog(
            onDismissRequest = { if (!working) deleting = false },
            title = { Text("Delete your account?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    val noPassword = vm.me?.hasPassword == false
                    Text(if (noPassword) "Everything in it is deleted for good. You sign in with Google, so type DELETE to confirm." else "Everything in it is deleted for good. Enter your password to confirm.")
                    OutlinedTextField(password, { password = it }, label = { Text(if (noPassword) "Type DELETE" else "Password") }, singleLine = true,
                        visualTransformation = if (noPassword) androidx.compose.ui.text.input.VisualTransformation.None else PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = if (noPassword) KeyboardType.Text else KeyboardType.Password))
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            },
            confirmButton = {
                TextButton(enabled = password.isNotEmpty() && !working, onClick = {
                    working = true; error = null
                    scope.launch { if (!vm.deleteAccount(password)) { error = vm.message; vm.message = null; working = false } }
                }) { Text("Delete account", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(enabled = !working, onClick = { deleting = false }) { Text("Cancel") } },
        )
    }
}

/** Passkeys: sign in with this phone's screen lock instead of a password. */
@Composable
private fun PasskeysCard(vm: AppViewModel) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var list by remember { mutableStateOf<List<com.activetogether.companion.Passkey>?>(null) }
    var note by remember { mutableStateOf<String?>(null) }
    suspend fun load() { list = vm.call { it.passkeys() } }
    LaunchedEffect(Unit) { load() }
    SectionCard("Passkeys") {
        EmptyNote("Sign in with your fingerprint, face or PIN instead of a password.")
        list?.forEach { k ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(k.name, style = MaterialTheme.typography.titleSmall)
                    Text("Added ${k.createdAt.take(10)}" + (k.lastUsedAt?.let { " · last used ${it.take(10)}" } ?: ""), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                TextButton(onClick = { scope.launch { if (vm.call { it.removePasskey(k.id) } != null) load() } }) { Text("Remove") }
            }
        }
        OutlinedButton(onClick = { scope.launch { val e = vm.addPasskey(context); note = e?.takeIf { it.isNotEmpty() }; if (e == null) { vm.message = "Passkey added"; load() } } }) { Text("Add a passkey on this phone") }
        note?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}

/** Two-step sign-in: set it up with an authenticator app (on this phone or another), keep the backup codes; new codes, or off. */
@Composable
private fun TwoStepCard(vm: AppViewModel) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val me = vm.me ?: return
    var secret by remember { mutableStateOf<Pair<String, String>?>(null) }
    var code by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var codes by remember { mutableStateOf<List<String>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    fun copy(text: String) { (context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager).setPrimaryClip(android.content.ClipData.newPlainText("Active Together", text)); vm.message = "Copied" }
    SectionCard("Two-step sign-in") {
        val shown = codes
        when {
            shown != null -> {
                Text("Your backup codes. Each works once instead of a code from the app, if you lose your phone. Keep them somewhere safe: they won't be shown again.", style = MaterialTheme.typography.bodyMedium)
                Text(shown.joinToString("\n"), fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { copy(shown.joinToString("\n")) }) { Text("Copy the codes") }
                    Button(onClick = { codes = null; scope.launch { vm.refreshMe() } }) { Text("Done") }
                }
            }
            me.twoFactor -> {
                Text("On: signing in asks for a code from your authenticator app after your password.", style = MaterialTheme.typography.bodyMedium)
                if (!me.hasPassword) EmptyNote("Set a password first to make new backup codes or switch this off.")
                else {
                    OutlinedTextField(password, { password = it }, label = { Text("Your password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(enabled = password.isNotEmpty(), onClick = { scope.launch { vm.call { it.twoStepNewBackupCodes(password) }?.let { codes = it; password = "" } } }) { Text("New backup codes") }
                        TextButton(enabled = password.isNotEmpty(), onClick = { scope.launch { if (vm.call { it.twoStepDisable(password) } != null) { password = ""; vm.refreshMe(); vm.message = "Two-step sign-in is off" } } }) { Text("Turn off") }
                    }
                }
            }
            secret == null -> {
                Text("Off. Turn it on so a stolen password isn't enough to sign in as you" + (if (me.adminNeedsTwoFactor) " - global admins need it for the admin tools." else "."), style = MaterialTheme.typography.bodyMedium)
                Button(onClick = { scope.launch { vm.call { it.twoStepSetup() }?.let { secret = it } } }) { Text("Set it up") }
            }
            else -> {
                val (sec, uri) = secret!!
                Text("1. Add Active Together to an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password...):", style = MaterialTheme.typography.bodyMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(uri))) }.onFailure { error = "No authenticator app on this phone: copy the key into one instead." } }) { Text("Open in authenticator app") }
                    TextButton(onClick = { copy(sec) }) { Text("Copy the key") }
                }
                Text(sec.chunked(4).joinToString(" "), fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                Text("2. Type the 6-digit code it shows:", style = MaterialTheme.typography.bodyMedium)
                OutlinedTextField(code, { code = it.filter(Char::isDigit).take(6) }, label = { Text("Code") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
                Button(enabled = code.length == 6, onClick = { scope.launch { vm.call { it.twoStepEnable(code) }?.let { codes = it; secret = null; code = "" } } }) { Text("Turn on") }
            }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}

/** Signed-in devices: each browser and phone signed in to my account, signing out any one, or all but this phone. */
@Composable
private fun DevicesCard(vm: AppViewModel) {
    val scope = rememberCoroutineScope()
    var list by remember { mutableStateOf<List<com.activetogether.companion.DeviceSession>?>(null) }
    var confirmAll by remember { mutableStateOf(false) }
    suspend fun load() { list = vm.sessions() }
    LaunchedEffect(Unit) { load() }
    SectionCard("Signed-in devices") {
        val l = list
        if (l == null) Loading(Modifier.padding(4.dp))
        else l.forEach { d ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(d.device + if (d.current) " (this phone)" else "", style = MaterialTheme.typography.titleSmall)
                    Text("Signed in ${d.createdAt.take(10)}" + (d.lastUsedAt?.let { " · last used ${it.take(10)}" } ?: ""), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!d.current) TextButton(onClick = { scope.launch { if (vm.signOutSession(d.id)) load() } }) { Text("Sign out") }
            }
        }
        if ((l?.size ?: 0) > 1) OutlinedButton(onClick = { confirmAll = true }) { Text("Sign out of all other devices") }
    }
    if (confirmAll) AlertDialog(
        onDismissRequest = { confirmAll = false },
        title = { Text("Sign out everywhere else?") },
        text = { Text("Other phones and browsers are signed out. This phone stays signed in.") },
        confirmButton = { TextButton(onClick = { confirmAll = false; scope.launch { vm.signOutOthers()?.let { n -> vm.message = "Signed out of $n other device${if (n == 1) "" else "s"}"; load() } } }) { Text("Sign out others") } },
        dismissButton = { TextButton(onClick = { confirmAll = false }) { Text("Cancel") } },
    )
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

    // Turning routes on asks Health Connect for every route at once; where it can't, Sync asks per workout.
    val routesLauncher = rememberLauncherForActivityResult(PermissionController.createRequestPermissionResultContract()) { }

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
            "Upload each workout's route so you can see it on a map. Only you can see your routes. If Health Connect can't share every route at once, Sync asks per workout.",
            routes) { on ->
            routes = on; vm.prefs.includeRoutes = on
            if (on) runCatching { routesLauncher.launch(setOf(vm.health.routesPermission)) }
        }
        Dropdown("Distance unit I type in", listOf("mi", "km"), unit, { if (it == "km") "Kilometres" else "Miles" }, { u -> unit = u; vm.prefs.preferredUnit = u })
    }
}
