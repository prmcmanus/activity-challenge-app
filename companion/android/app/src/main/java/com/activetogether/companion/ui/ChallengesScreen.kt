package com.activetogether.companion.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.DirectionsWalk
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Straighten
import androidx.compose.material.icons.filled.Timer
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.GroupAdd
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.IconButton
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TextButton
import androidx.compose.ui.platform.LocalContext
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.activetogether.companion.Challenge
import com.activetogether.companion.TeamInfo
import com.activetogether.companion.asChallenge
import com.activetogether.companion.SERVER_URL
import java.time.LocalDate

/** "London → Edinburgh · 412 miles by road · on foot", as on the website. */
fun journeyLine(j: com.activetogether.companion.Journey): String {
    val length = if (j.unit == "steps") "${fmtSteps(Math.round(j.target / 1000.0) * 1000)} steps" else "${fmtNum(if (j.target >= 100) Math.round(j.target).toDouble() else j.target)} ${if (j.unit == "km") "km" else "miles"}"
    val places = if (j.via.size <= 2) (listOf(j.fromName) + j.via.map { it.name } + j.toName).joinToString(" → ")
        else "${j.fromName} → ${j.toName} (via ${j.via.size} stops)"
    return "$places · $length ${if (j.shape == "straight") "as the crow flies" else "by road"} · ${if (j.cycling) "cycling" else "on foot"}"
}
/** A journey leaderboard's extra: how far along the route, or a chequered flag once finished. */
private fun progressText(s: com.activetogether.companion.Standing) = when {
    s.finishedOn != null -> " 🏁"
    s.progress != null -> " · ${Math.round(s.progress * 100)}%"
    else -> ""
}

/** "3rd of 7 · 14 min behind Priya", my team's place, and my last 7 days - as on the website. */
private fun standingText(c: Challenge, s: com.activetogether.companion.MyStanding): String {
    fun amt(v: Double) = fmtMeasure(c.measuresDistance, v, v, c.distanceUnit, c.measuresSteps, v)
    fun nth(n: Int) = n.toString() + when { n % 100 in 11..13 -> "th"; n % 10 == 1 -> "st"; n % 10 == 2 -> "nd"; n % 10 == 3 -> "rd"; else -> "th" }
    val first = when {
        s.total == 0.0 && s.aheadName == null -> if (s.of > 1) "Nobody's logged anything yet - be the first!" else "Log something to get going."
        s.aheadName == null -> if (s.rank == 1 && s.of > 1) "You're in the lead!" else "${nth(s.rank)} of ${s.of}"
        else -> "${nth(s.rank)} of ${s.of} · ${amt(s.aheadGap ?: 0.0)} behind ${s.aheadName}"
    }
    return listOfNotNull(first, s.teamRank?.let { "Your team: ${nth(it)} of ${s.teamOf}" }, "${amt(s.week)} in the last 7 days").joinToString("\n")
}

private fun measureLabel(c: Challenge) = if (c.measuresSteps) "Steps" else if (c.measuresDistance) (if (c.distanceUnit == "km") "Kilometres" else "Miles") else "Active minutes"
private fun myTotal(c: Challenge) = fmtMeasure(c.measuresDistance, c.myMinutes, c.myDistance, c.distanceUnit, c.measuresSteps, c.mySteps)

private fun stateLabel(c: Challenge): String {
    val today = LocalDate.now()
    return when {
        today.isBefore(c.startDate) -> "Starts ${fmtDay(c.startDate)}"
        today.isAfter(c.endDate) -> "Finished"
        else -> "${java.time.temporal.ChronoUnit.DAYS.between(today, c.endDate) + 1} days left"
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ChallengesScreen(vm: AppViewModel, newChallenge: () -> Unit, join: () -> Unit, open: (Challenge) -> Unit) {
    val scope = rememberCoroutineScope()
    var leaving by remember { mutableStateOf<Challenge?>(null) }
    // Box and list both fill the screen: with only a card or two, a pull on the empty space below
    // them otherwise lands outside the list and nothing happens.
    PullToRefreshBox(isRefreshing = vm.topRefreshing, onRefresh = { vm.refreshTop() }, modifier = Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PagePadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Hero(LocalDate.now().format(java.time.format.DateTimeFormatter.ofPattern("EEEE d MMMM", java.util.Locale.getDefault())), "Hi ${vm.me?.name?.substringBefore(' ') ?: ""}".trim(), below = {
                    Text("${vm.challenges.count { it.isActive }} active challenge${if (vm.challenges.count { it.isActive } == 1) "" else "s"}",
                        color = Color.White.copy(alpha = 0.9f), modifier = Modifier.padding(top = 4.dp))
                })
            }
            if (vm.update != null) item { UpdateBanner(vm) }
            // An email address to confirm (or a new one waiting to be), with the link sent again on request.
            val m = vm.me
            if (m != null && vm.config?.emailEnabled == true && (!m.emailVerified || m.pendingEmail != null)) item {
                var sentTo by remember { mutableStateOf<String?>(null) }
                SectionCard {
                    Text("Confirm your ${if (m.pendingEmail != null) "new " else ""}email address", style = MaterialTheme.typography.titleMedium)
                    Text("We sent a link to ${m.pendingEmail ?: m.email}${m.pendingEmail?.let { "; until you open it we'll keep using ${m.email}" } ?: ""}. Nothing there? Check your spam folder.",
                        style = MaterialTheme.typography.bodyMedium)
                    sentTo?.let { Text("Sent to $it.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary) }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { scope.launch { vm.resendEmailCheck()?.let { sentTo = it } } }) { Text("Send it again") }
                        if (m.pendingEmail != null) TextButton(onClick = { scope.launch { vm.keepEmail() } }) { Text("Keep my current address") }
                    }
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = newChallenge, modifier = Modifier.weight(1f)) { Icon(Icons.Default.Add, null); Spacer(Modifier.width(6.dp)); Text("New challenge") }
                    OutlinedButton(onClick = join, modifier = Modifier.weight(1f)) { Icon(Icons.Default.GroupAdd, null); Spacer(Modifier.width(6.dp)); Text("Join with code") }
                }
            }
            // Someone added me to a challenge: say who, and let me keep it or leave.
            items(vm.challenges.filter { it.addedBy != null }, key = { "added-${it.id}" }) { c ->
                SectionCard {
                    Text("${c.addedBy} added you to ${c.name} (${fmtRange(c.startDate, c.endDate)}).", style = MaterialTheme.typography.bodyLarge)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { scope.launch { vm.ackAdded(c.id); open(c) } }) { Text("Open") }
                        OutlinedButton(onClick = { scope.launch { vm.ackAdded(c.id) } }) { Text("Keep") }
                        TextButton(onClick = { leaving = c }) { Text("Leave") }
                    }
                }
            }
            if (vm.challenges.isEmpty() && !vm.loadingChallenges) {
                item { SectionCard { EmptyNote("You're not in a challenge yet. Start one, or join with an invite code someone shared with you.") } }
            }
            items(vm.challenges.sortedWith(compareBy<Challenge> { !it.isActive }.thenByDescending { it.startDate }), key = { it.id }) { c ->
                SectionCard(modifier = Modifier.clickable { open(c) }) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(c.name, style = MaterialTheme.typography.titleLarge)
                            Text(fmtRange(c.startDate, c.endDate), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Column(horizontalAlignment = Alignment.End) {
                            Text(myTotal(c), style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.primary)
                            Text("logged by me", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Icon(Icons.Default.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        AssistChip(onClick = { open(c) }, label = { Text(if (c.journey != null) "Journey · ${measureLabel(c)}" else measureLabel(c), maxLines = 1) },
                            leadingIcon = { Icon(if (c.measuresSteps) Icons.AutoMirrored.Filled.DirectionsWalk else if (c.measuresDistance) Icons.Default.Straighten else Icons.Default.Timer, null, Modifier.padding(0.dp)) })
                        AssistChip(onClick = { open(c) }, label = { Text(if (c.individual) "Individual" else c.myTeams.firstOrNull()?.name ?: "No team yet", maxLines = 1) },
                            leadingIcon = { Icon(if (c.individual) Icons.Default.Person else Icons.Default.Groups, null) })
                        AssistChip(onClick = { open(c) }, label = { Text(stateLabel(c), maxLines = 1) },
                            colors = AssistChipDefaults.assistChipColors(containerColor = if (c.isActive) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent))
                    }
                }
            }
        }
    }
    leaving?.let { c ->
        AlertDialog(
            onDismissRequest = { leaving = null },
            title = { Text("Leave ${c.name}?") },
            text = { Text("Anything you've logged in it is deleted, and you'll need an invite to join again.") },
            confirmButton = { TextButton(onClick = { leaving = null; scope.launch { vm.leaveChallenge(c.id) } }) { Text("Leave challenge") } },
            dismissButton = { TextButton(onClick = { leaving = null }) { Text("Cancel") } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChallengeDetailScreen(vm: AppViewModel, challengeId: Int, edit: () -> Unit, left: () -> Unit, members: () -> Unit, manageTeam: (Int) -> Unit, openProfile: (Int) -> Unit) {
    LaunchedEffect(challengeId) { vm.loadLeaderboard(challengeId); vm.loadDetail(challengeId) }
    // A global admin can open a challenge they haven't joined; it's not on their dashboard, so it comes from the full record.
    val c = vm.challenges.firstOrNull { it.id == challengeId } ?: vm.details[challengeId]?.asChallenge() ?: run { Loading(); return }
    val board = vm.leaderboards.value[challengeId]
    val detail = vm.details[challengeId]
    val context = LocalContext.current
    var newTeam by remember { mutableStateOf("") }
    var tab by remember { mutableIntStateOf(if (c.individual) 1 else 0) }
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    var leavingTeam by remember { mutableStateOf<TeamInfo?>(null) }
    var leavingChallenge by remember { mutableStateOf(false) }
    var newCode by remember { mutableStateOf(false) }

    PullToRefreshBox(isRefreshing = refreshing, onRefresh = { scope.launch { refreshing = true; vm.refreshChallenge(challengeId); refreshing = false } }, modifier = Modifier.fillMaxSize()) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PagePadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Hero("${fmtRange(c.startDate, c.endDate)} · ${stateLabel(c)}", c.name,
                trailing = { HeroStat(if (c.measuresSteps) fmtSteps(c.mySteps) else if (c.measuresDistance) fmtNum(c.myDistance) else fmtNum(c.myMinutes),
                    if (c.measuresSteps) "my steps" else if (c.measuresDistance) "my ${if (c.distanceUnit == "km") "km" else "miles"}" else "my minutes") },
                below = {
                    Text(listOfNotNull(measureLabel(c), if (c.individual) "Individuals" else c.myTeams.joinToString { it.name }.ifBlank { null }, "Role: ${c.role}").joinToString(" · "),
                        color = Color.White.copy(alpha = 0.9f), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 6.dp))
                    c.journey?.let { Text("🗺 " + journeyLine(it), color = Color.White, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 4.dp)) }
                    board?.me?.let { s -> Text(standingText(c, s), color = Color.White, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 6.dp)) }
                })
        }
        // A virtual journey: the map of where everyone has got to. Reloaded with the leaderboard.
        if (c.journey != null) item {
            var map by remember(challengeId) { mutableStateOf<com.activetogether.companion.JourneyMap?>(null) }
            var full by remember { mutableStateOf(false) }
            LaunchedEffect(challengeId, board) { vm.call { it.journey(challengeId) }?.let { map = it } }
            val describe = { mk: com.activetogether.companion.JourneyMarker ->
                val total = if (c.measuresSteps) "${fmtSteps(mk.steps)} steps" else "${fmtNum(mk.distance)} ${if (c.distanceUnit == "km") "km" else "mi"}"
                val unitWord = if (c.measuresSteps) "steps" else if (c.distanceUnit == "km") "km" else "mi"
                "$total · ${Math.round(mk.progress * 100)}%" + (mk.finishedOn?.let { " · finished $it" }
                    ?: mk.nextName?.let { n -> " · next: $n, ${mk.nextRemaining?.let { r -> if (r >= 10) Math.round(r).toString() else fmtNum(r) } ?: ""} $unitWord to go" } ?: "")
            }
            SectionCard("Journey map", action = {
                map?.let { m -> Text("${m.markers.count { it.finishedOn != null }} of ${m.markers.size} finished", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                if (map != null) IconButton(onClick = { full = true }) { Icon(Icons.Default.Fullscreen, "Full screen") }
            }) {
                val m = map
                if (m == null) Loading(Modifier.padding(8.dp))
                else JourneyMapView(m, describe = describe, modifier = Modifier.fillMaxWidth().height(320.dp))
                // The same map filling the screen, with a close button over it.
                if (full && m != null) androidx.compose.ui.window.Dialog(onDismissRequest = { full = false },
                    properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
                    androidx.compose.foundation.layout.Box(Modifier.fillMaxSize()) {
                        JourneyMapView(m, describe = describe, modifier = Modifier.fillMaxSize())
                        androidx.compose.material3.FilledTonalButton(onClick = { full = false },
                            modifier = Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(12.dp)) {
                            Icon(Icons.Default.Close, null); Spacer(Modifier.width(6.dp)); Text("Close")
                        }
                    }
                }
                Text(if (c.journey.cycling) "A cycling journey: only rides count. Positions are virtual, never anyone's real location."
                    else "A journey on foot: rides don't count. Positions are virtual, never anyone's real location.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (c.descriptionHtml.isNotBlank()) {
            item { SectionCard("About") { Text(htmlToText(c.descriptionHtml), style = MaterialTheme.typography.bodyMedium) } }
        }
        if (detail != null) item {
            SectionCard("Invite people", action = {
                if (detail.canManage) TextButton(onClick = edit) { Icon(Icons.Default.Edit, null); Spacer(Modifier.width(4.dp)); Text("Edit") }
            }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Invite code", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(detail.inviteCode, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    }
                    OutlinedButton(onClick = { shareInvite(context, detail.name, detail.inviteCode) }) { Icon(Icons.Default.Share, null); Spacer(Modifier.width(6.dp)); Text("Share") }
                }
                // Owners: the people in it, and a new code if the old one got around.
                if (detail.canManage) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = members) { Icon(Icons.Default.Groups, null); Spacer(Modifier.width(6.dp)); Text("Members") }
                    TextButton(onClick = { newCode = true }) { Text("New invite code") }
                }
            }
        }
        if (detail != null && !c.individual) item {
            SectionCard("Teams") {
                if (c.myTeams.isEmpty()) Text("You're not in a team yet. Join one or start your own to log activity here.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                if (detail.teams.isEmpty()) EmptyNote("No teams yet - create the first one.")
                detail.teams.forEachIndexed { i, t ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Avatar(t.imageUrl, t.name)
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(t.name, style = MaterialTheme.typography.titleMedium)
                            Text(listOfNotNull("${t.members} member${if (t.members == 1) "" else "s"}", if (t.mine) "your team" else null, t.inviteCode?.let { "code $it" }).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (!t.mine && detail.role != "admin") TextButton(onClick = { scope.launch { vm.joinTeam(challengeId, t.id) } }) { Text("Join") }
                        if (t.mine) TextButton(onClick = { leavingTeam = t }) { Text("Leave") }
                        if (t.canManage) TextButton(onClick = { manageTeam(t.id) }) { Text("Manage") }
                    }
                    if (i < detail.teams.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                }
                if (detail.role != "admin") Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(newTeam, { newTeam = it }, label = { Text("New team name") }, singleLine = true, modifier = Modifier.weight(1f))
                    Button(onClick = { scope.launch { if (vm.createTeam(challengeId, newTeam)) newTeam = "" } }, enabled = newTeam.isNotBlank()) { Text("Create") }
                }
            }
        }
        item {
            SectionCard("Leaderboard") {
                if (!c.individual) {
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                        SegmentedButton(tab == 0, { tab = 0 }, SegmentedButtonDefaults.itemShape(0, 2)) { Text("Teams") }
                        SegmentedButton(tab == 1, { tab = 1 }, SegmentedButtonDefaults.itemShape(1, 2)) { Text("Individuals") }
                    }
                }
                when {
                    board == null -> Loading(Modifier.padding(8.dp))
                    else -> {
                        val rows = if (tab == 0 && !c.individual) board.teams else board.users
                        if (rows.isEmpty()) EmptyNote("Nobody on the board yet.")
                        if (rows === board.users) Text("Tap someone to see their profile.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        rows.forEachIndexed { i, s ->
                            val person = s.userId
                            Row(Modifier.fillMaxWidth().then(if (person != null) Modifier.clickable { openProfile(person) } else Modifier).padding(vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically) {
                                Text("${i + 1}", fontWeight = FontWeight.Black, color = if (i < 3) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.width(30.dp))
                                Avatar(s.imageUrl, s.name)
                                Spacer(Modifier.width(10.dp))
                                Text(s.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                                Text(fmtMeasure(c.measuresDistance, s.minutes, s.distance, c.distanceUnit, c.measuresSteps, s.steps) + progressText(s), style = MaterialTheme.typography.titleMedium)
                                if (person != null) Icon(Icons.Default.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            if (i < rows.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        }
                    }
                }
            }
        }
        if (detail != null && detail.role != "admin") item {
            OutlinedButton(onClick = { leavingChallenge = true }, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.AutoMirrored.Filled.Logout, null); Spacer(Modifier.width(8.dp)); Text("Leave challenge")
            }
        }
    }
    }
    if (newCode && detail != null) NewInviteCodeDialog(vm, team = false, id = challengeId, what = "this challenge", dismiss = { newCode = false }) { code ->
        newCode = false; scope.launch { vm.afterManage(challengeId); vm.message = "New invite code: $code" }
    }
    leavingTeam?.let { t ->
        AlertDialog(
            onDismissRequest = { leavingTeam = null },
            title = { Text("Leave ${t.name}?") },
            text = { Text("What you've logged under this team stays on its total. You stay in the challenge.") },
            confirmButton = { TextButton(onClick = { leavingTeam = null; scope.launch { vm.leaveTeam(challengeId, t.id) } }) { Text("Leave team") } },
            dismissButton = { TextButton(onClick = { leavingTeam = null }) { Text("Cancel") } },
        )
    }
    if (leavingChallenge) {
        AlertDialog(
            onDismissRequest = { leavingChallenge = false },
            title = { Text("Leave ${c.name}?") },
            text = { Text("Everything you've logged in it is deleted, and you'll need an invite to join again.") },
            confirmButton = { TextButton(onClick = { leavingChallenge = false; scope.launch { if (vm.leaveChallenge(challengeId)) left() } }) { Text("Leave challenge") } },
            dismissButton = { TextButton(onClick = { leavingChallenge = false }) { Text("Cancel") } },
        )
    }
}
