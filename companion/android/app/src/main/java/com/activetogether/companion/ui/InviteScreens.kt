package com.activetogether.companion.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.activetogether.companion.ActiveTogetherApi
import com.activetogether.companion.BuildConfig
import com.activetogether.companion.InvitePreview
import com.activetogether.companion.SERVER_URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private fun inviteTitle(p: InvitePreview) = if (p.isTeam) "${p.teamName} in ${p.challengeName}" else p.challengeName
private fun inviteDetail(p: InvitePreview) = listOf(
    fmtRange(p.startDate, p.endDate),
    if (p.measuresSteps) "counts steps" else if (p.measuresDistance) "measures distance (${if (p.distanceUnit == "km") "km" else "miles"})" else "measures active minutes",
    if (p.individual) "individuals" else "teams",
    "${p.members} member${if (p.members == 1) "" else "s"}",
).joinToString(" · ")

fun openInBrowser(context: Context, url: String) = context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))

/** An invite link, opened while signed in: say what it's for and ask before joining. */
@Composable
fun InviteScreen(vm: AppViewModel, code: String, opened: (Int) -> Unit, dismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var preview by remember { mutableStateOf<InvitePreview?>(null) }
    var failed by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(code) {
        vm.clearInvite()
        try { preview = withContext(Dispatchers.IO) { vm.api().invitePreview(code) } } catch (e: Exception) { failed = e.message ?: "Couldn't check that invite" }
    }
    Column(Modifier.verticalScroll(rememberScrollState()).padding(PagePadding), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        val p = preview
        when {
            failed != null -> SectionCard("Invite link") {
                Text(failed!!, color = MaterialTheme.colorScheme.error)
                Text("Ask whoever sent it for a new link or code.", style = MaterialTheme.typography.bodyMedium)
                OutlinedButton(onClick = dismiss) { Text("OK") }
            }
            p == null -> Loading()
            else -> {
                Hero(if (p.alreadyIn) "You're already in" else "You're invited", inviteTitle(p))
                SectionCard {
                    Text(inviteDetail(p), style = MaterialTheme.typography.bodyMedium)
                    if (p.isTeam && p.member == true && p.inTeam != true) Text("You're already in the challenge; this adds you to the team.", style = MaterialTheme.typography.bodySmall)
                    if (p.alreadyIn) {
                        Button(onClick = { opened(p.challengeId) }, modifier = Modifier.fillMaxWidth()) { Text("Open the challenge") }
                    } else {
                        Button(onClick = { busy = true; scope.launch { val id = vm.join(code); busy = false; if (id != null) opened(id) } },
                            enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text(if (busy) "Joining..." else if (p.isTeam) "Join the team" else "Join the challenge") }
                        TextButton(onClick = dismiss, modifier = Modifier.fillMaxWidth()) { Text("Not now") }
                    }
                }
            }
        }
    }
}

/** On the sign-in screen when an invite link brought them here. */
@Composable
fun InviteSignInCard(code: String) {
    val context = LocalContext.current
    var preview by remember { mutableStateOf<InvitePreview?>(null) }
    LaunchedEffect(code) { preview = runCatching { withContext(Dispatchers.IO) { ActiveTogetherApi().invitePreview(code) } }.getOrNull() }
    Card(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.large, colors = CardDefaults.cardColors(containerColor = BrandYellow)) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("You're invited", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = androidx.compose.ui.graphics.Color.Black)
            Text(preview?.let { "Join ${inviteTitle(it)}." } ?: "Sign in to see the invite.", color = androidx.compose.ui.graphics.Color.Black)
            Text("Sign in below and we'll ask you to confirm. New to Active Together? Create an account on the website first, then come back and sign in.",
                style = MaterialTheme.typography.bodySmall, color = androidx.compose.ui.graphics.Color.Black)
            // Not /join/CODE: that link would open this app again rather than the website.
            TextButton(onClick = { openInBrowser(context, "$SERVER_URL/?code=$code") }) { Text("Create an account") }
        }
    }
}

/** "Update available" with a download that works in the phone's browser. */
@Composable
fun UpdateBanner(vm: AppViewModel) {
    val u = vm.update ?: return
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    Card(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.large, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.SystemUpdate, null)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text("Update available", style = MaterialTheme.typography.titleMedium)
                Text("Version ${u.version} (you have ${BuildConfig.VERSION_NAME}). Download it, then open the file to install.",
                    style = MaterialTheme.typography.bodySmall)
            }
            Button(enabled = !busy, onClick = { busy = true; scope.launch { vm.updateLink()?.let { openInBrowser(context, it) }; busy = false } }) { Text("Download") }
        }
    }
}
