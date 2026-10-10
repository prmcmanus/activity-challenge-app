package com.activetogether.companion.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AddPhotoAlternate
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Lightbulb
import androidx.compose.material.icons.filled.QuestionAnswer
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.activetogether.companion.SERVER_URL
import com.activetogether.companion.Ticket
import com.activetogether.companion.TicketComment
import com.activetogether.companion.TicketList
import com.activetogether.companion.serverUrl
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

val TICKET_TYPES = listOf("bug" to "Bug", "feature" to "Feature request", "question" to "Question")
val TICKET_STATUSES = listOf("new" to "New", "in_progress" to "In progress", "planned" to "Planned", "done" to "Done", "declined" to "Declined")
fun ticketTypeLabel(t: String) = TICKET_TYPES.firstOrNull { it.first == t }?.second ?: t
fun ticketStatusLabel(s: String) = TICKET_STATUSES.firstOrNull { it.first == s }?.second ?: s

/** Server times are UTC "YYYY-MM-DD HH:MM:SS[.mmm]"; shown in local time. */
fun fmtWhen(s: String): String = runCatching {
    LocalDateTime.parse(s.take(19).replace(' ', 'T')).atOffset(ZoneOffset.UTC).atZoneSameInstant(ZoneId.systemDefault())
        .format(DateTimeFormatter.ofPattern("d MMM, HH:mm", Locale.getDefault()))
}.getOrDefault(s)

@Composable
fun StatusPill(status: String) {
    val (bg, fg) = when (status) {
        "new" -> Color(0xFFFFF3C4) to Color(0xFF5C4500)
        "in_progress" -> Color(0xFFDBE9FF) to Color(0xFF0B3D91)
        "planned" -> Color(0xFFE8DEFC) to Color(0xFF4A2A91)
        "done" -> Color(0xFFD9F2DF) to Color(0xFF14532D)
        else -> Color(0xFFEDEDED) to Color(0xFF555555)
    }
    Text(ticketStatusLabel(status), color = fg, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold,
        modifier = Modifier.clip(MaterialTheme.shapes.small).background(bg).padding(horizontal = 8.dp, vertical = 3.dp))
}

@Composable
private fun TicketRow(t: Ticket, showReporter: Boolean, open: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = open).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(when (t.type) { "bug" -> Icons.Default.BugReport; "feature" -> Icons.Default.Lightbulb; else -> Icons.Default.QuestionAnswer }, null,
            tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (t.unread) { Box(Modifier.size(9.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary)); Spacer(Modifier.width(6.dp)) }
                Text(t.title, style = MaterialTheme.typography.titleMedium, fontWeight = if (t.unread) FontWeight.ExtraBold else FontWeight.SemiBold)
            }
            Text(listOfNotNull("#${t.id}", if (showReporter) t.reporterName else null, "updated ${fmtWhen(t.updatedAt)}",
                if (t.commentCount > 0) "${t.commentCount} repl${if (t.commentCount == 1) "y" else "ies"}" else null).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        StatusPill(t.status)
    }
}

private val FAQ = listOf(
    "How do challenges work?" to "A challenge runs between two dates and measures either active minutes or distance (miles or km), in teams or by individuals. Join one with the invite code its owner shares at ${SERVER_URL.removePrefix("https://")}.",
    "How do I log activity?" to "Sync it from Health Connect on the Sync tab, or tap + on the Activity tab to log it by hand. One workout counts in every challenge it fits - you choose which. The date must fall within the challenge.",
    "Why didn't a workout count in my distance challenge?" to "It has no recorded distance (yoga or gym sessions, for example). In Sync, type the distance in the review; for an entry already logged, open it and tap Edit activity.",
    "How does automatic sync work?" to "Switch it on under Me. New workouts go into every challenge they fit every few hours (if Health Connect allows background reading) and whenever you open the app. Workouts with no distance skip distance challenges.",
    "Who can see my profile and activity?" to "Only people in a challenge with you, and only for challenges you share. Choose Private, Totals or Full under Me > Edit. GPS routes are only ever visible to you.",
    "How long is data kept, and can I delete it?" to "A challenge and everything in it is deleted 60 days after it ends, or earlier if its owner deletes it. You can remove any entry you logged. To delete your account, send a ticket.",
)

/** Help: quick answers, a way to report a bug or request a feature, my tickets, and (admins) the dashboard. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HelpScreen(vm: AppViewModel, newTicket: () -> Unit, openTicket: (Int) -> Unit, dashboard: () -> Unit) {
    val scope = rememberCoroutineScope()
    var list by remember { mutableStateOf<TicketList?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var openFaq by remember { mutableStateOf<Int?>(null) }
    fun load() = scope.launch { vm.call { it.tickets() }?.let { list = it }; vm.refreshHelpBadge() }
    LaunchedEffect(Unit) { load() }

    PullToRefreshBox(modifier = Modifier.fillMaxSize(), isRefreshing = refreshing, onRefresh = { scope.launch { refreshing = true; load().join(); refreshing = false } }) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PagePadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Hero("Help & support", "How can we help?", below = {
                    Text("Quick answers below. Something broken, or an idea? Send a ticket and follow the replies here.",
                        color = Color.White.copy(alpha = 0.92f), modifier = Modifier.padding(top = 6.dp))
                })
            }
            if (vm.me?.isAdmin == true) {
                item {
                    OutlinedButton(onClick = dashboard, modifier = Modifier.fillMaxWidth()) {
                        Icon(Icons.Default.SupportAgent, null); Spacer(Modifier.width(8.dp)); Text("Support dashboard")
                    }
                }
            }
            item {
                Button(onClick = newTicket, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Default.BugReport, null); Spacer(Modifier.width(8.dp)); Text("Report a bug or request a feature")
                }
            }
            item {
                SectionCard("My tickets") {
                    val l = list
                    when {
                        l == null -> Loading(Modifier.height(80.dp))
                        l.tickets.isEmpty() -> EmptyNote("You haven't sent any tickets yet.")
                        else -> l.tickets.forEachIndexed { i, t ->
                            TicketRow(t, false) { openTicket(t.id) }
                            if (i < l.tickets.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        }
                    }
                }
            }
            item {
                SectionCard("Quick answers") {
                    FAQ.forEachIndexed { i, (q, a) ->
                        Column(Modifier.fillMaxWidth().clickable { openFaq = if (openFaq == i) null else i }.animateContentSize().padding(vertical = 6.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(q, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                                Icon(if (openFaq == i) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null)
                            }
                            if (openFaq == i) Text(a, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 6.dp))
                        }
                        if (i < FAQ.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    }
                }
            }
        }
    }
}

private fun screenshotDataUrl(context: Context, uri: Uri): String {
    val src = context.contentResolver.openInputStream(uri).use { BitmapFactory.decodeStream(it) } ?: error("Couldn't read that image")
    val scale = 1600f / maxOf(src.width, src.height)
    val bmp = if (scale < 1f) Bitmap.createScaledBitmap(src, (src.width * scale).toInt(), (src.height * scale).toInt(), true) else src
    val out = ByteArrayOutputStream()
    bmp.compress(Bitmap.CompressFormat.JPEG, 85, out)
    return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
}

/** Report a bug, request a feature or ask a question. The phone and app version go along automatically. */
@Composable
fun NewTicketScreen(vm: AppViewModel, sent: (Int) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var type by remember { mutableStateOf("bug") }
    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var image by remember { mutableStateOf<Uri?>(null) }
    var busy by remember { mutableStateOf(false) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { image = it }
    val version = remember { runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: "?" }
    val clientInfo = "Android ${Build.VERSION.RELEASE} · ${Build.MANUFACTURER} ${Build.MODEL} · app $version"

    Column(Modifier.verticalScroll(rememberScrollState()).padding(PagePadding), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionCard {
            Text("What is it?", style = MaterialTheme.typography.labelLarge)
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                TICKET_TYPES.forEachIndexed { i, (code, label) ->
                    SegmentedButton(type == code, { type = code }, SegmentedButtonDefaults.itemShape(i, TICKET_TYPES.size)) { Text(if (code == "feature") "Idea" else label) }
                }
            }
            OutlinedTextField(title, { title = it.take(120) }, label = { Text("Title") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                placeholder = { Text(if (type == "bug") "e.g. Sync misses my evening walks" else if (type == "feature") "e.g. A weekly summary" else "e.g. How do teams work?") })
            OutlinedTextField(description, { description = it.take(5000) }, label = { Text("Details") }, minLines = 5, modifier = Modifier.fillMaxWidth(),
                placeholder = { Text(if (type == "bug") "What happened, what you expected, and the steps to see it." else "Tell us more.") })
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }) {
                    Icon(Icons.Default.AddPhotoAlternate, null); Spacer(Modifier.width(8.dp)); Text(if (image == null) "Add a screenshot" else "Change screenshot")
                }
                image?.let { Spacer(Modifier.width(12.dp)); AsyncImage(it, null, contentScale = ContentScale.Crop, modifier = Modifier.size(56.dp).clip(MaterialTheme.shapes.small)) }
            }
            Text("Sent with it: $clientInfo", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Button(enabled = !busy && title.isNotBlank() && description.isNotBlank(), modifier = Modifier.fillMaxWidth(), onClick = {
            busy = true
            scope.launch {
                val url = image?.let { uri ->
                    val data = runCatching { withContext(Dispatchers.Default) { screenshotDataUrl(context, uri) } }.getOrElse { vm.message = it.message; busy = false; return@launch }
                    vm.call { it.uploadImage(data) } ?: run { busy = false; return@launch }
                }
                val id = vm.call { it.createTicket(type, title.trim(), description.trim(), url, clientInfo) }
                busy = false
                if (id != null) { vm.message = "Thanks - ticket #$id sent"; sent(id) }
            }
        }) { if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary) else { Icon(Icons.AutoMirrored.Filled.Send, null); Spacer(Modifier.width(8.dp)); Text("Send") } }
    }
}

/** One ticket: details, outcome, the conversation and a reply box. Admins also set status and outcome. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TicketScreen(vm: AppViewModel, id: Int) {
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<Pair<Ticket, List<TicketComment>>?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var reply by remember { mutableStateOf("") }
    var internal by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    var outcome by remember { mutableStateOf<String?>(null) }
    val admin = vm.me?.isAdmin == true
    fun load() = scope.launch {
        vm.call { it.ticket(id) }?.let { data = it; if (status == null) status = it.first.status; if (outcome == null) outcome = it.first.resolution.orEmpty() }
        vm.refreshHelpBadge()
    }
    LaunchedEffect(id) { load() }

    PullToRefreshBox(modifier = Modifier.fillMaxSize(), isRefreshing = refreshing, onRefresh = { scope.launch { refreshing = true; load().join(); refreshing = false } }) {
        val d = data ?: run { Loading(); return@PullToRefreshBox }
        val (t, comments) = d
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PagePadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                SectionCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        StatusPill(t.status); Spacer(Modifier.width(8.dp))
                        Text("${ticketTypeLabel(t.type)} · #${t.id} · ${if (t.mine) "you" else t.reporterName + (t.reporterEmail?.let { " ($it)" } ?: "")}",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = if (!t.mine && t.reporterId > 0) Modifier.clickable { vm.openProfile(t.reporterId) } else Modifier)
                    }
                    Text(t.title, style = MaterialTheme.typography.titleLarge)
                    Text(t.description, style = MaterialTheme.typography.bodyMedium)
                    t.imageUrl?.let { AsyncImage(serverUrl(it), "Screenshot", modifier = Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium), contentScale = ContentScale.FillWidth) }
                    t.clientInfo?.let { Text("Device: $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    Text("Sent ${fmtWhen(t.createdAt)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            t.resolution?.let { r ->
                item {
                    Column(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium).background(Color(0x221A7F37)).padding(14.dp)) {
                        Text("Outcome", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.tertiary)
                        Text(r, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
            if (admin) {
                item {
                    SectionCard("Support") {
                        Dropdown("Status", TICKET_STATUSES.map { it.first }, status ?: t.status, ::ticketStatusLabel, { status = it })
                        OutlinedTextField(outcome.orEmpty(), { outcome = it.take(2000) }, label = { Text("Outcome the reporter sees") }, modifier = Modifier.fillMaxWidth())
                        Button(enabled = !busy, onClick = {
                            busy = true
                            scope.launch { if (vm.call { it.updateTicket(id, status ?: t.status, outcome.orEmpty()) } != null) vm.message = "Ticket updated"; busy = false; load() }
                        }) { Text("Update status") }
                    }
                }
            }
            item { Text("Conversation", style = MaterialTheme.typography.titleLarge) }
            if (comments.isEmpty()) item { EmptyNote("No replies yet.") }
            items(comments, key = { it.id }) { c ->
                val bg = when { c.internal -> Color(0x33D40511); c.fromSupport -> Color(0x33FFCC00); else -> MaterialTheme.colorScheme.surfaceVariant }
                Column(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.medium).background(bg).padding(12.dp)) {
                    Text(listOfNotNull(c.authorName, if (c.fromSupport) "Support" else null, if (c.internal) "internal note - only admins see this" else null, fmtWhen(c.createdAt)).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = if (c.authorId > 0) Modifier.clickable { vm.openProfile(c.authorId) } else Modifier)
                    Text(c.body, style = MaterialTheme.typography.bodyMedium)
                }
            }
            item {
                SectionCard {
                    OutlinedTextField(reply, { reply = it.take(5000) }, label = { Text(if (admin && !t.mine) "Reply to the reporter" else "Add a reply") }, minLines = 3, modifier = Modifier.fillMaxWidth())
                    if (admin) Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { internal = !internal }) {
                        Checkbox(internal, { internal = it }); Text("Internal note (not shown to the reporter)")
                    }
                    Button(enabled = !busy && reply.isNotBlank(), onClick = {
                        busy = true
                        scope.launch {
                            if (vm.call { it.replyTicket(id, reply.trim(), internal) } != null) { reply = ""; internal = false }
                            busy = false; load()
                        }
                    }) { Icon(Icons.AutoMirrored.Filled.Send, null); Spacer(Modifier.width(8.dp)); Text("Send reply") }
                }
            }
        }
    }
}

/** Admins: every ticket, filterable by status and type, with counts. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun SupportDashboardScreen(vm: AppViewModel, openTicket: (Int) -> Unit) {
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf<String?>("open") }
    var type by remember { mutableStateOf<String?>(null) }
    var list by remember { mutableStateOf<TicketList?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    fun load() = scope.launch { vm.call { it.tickets(all = true, status = status, type = type) }?.let { list = it }; vm.refreshHelpBadge() }
    LaunchedEffect(status, type) { load() }

    PullToRefreshBox(modifier = Modifier.fillMaxSize(), isRefreshing = refreshing, onRefresh = { scope.launch { refreshing = true; load().join(); refreshing = false } }) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PagePadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                val l = list
                Hero("Admins only", "Support dashboard", below = {
                    if (l != null) Text("Open: ${l.openByType["bug"] ?: 0} bug(s), ${l.openByType["feature"] ?: 0} idea(s), ${l.openByType["question"] ?: 0} question(s)",
                        color = Color.White.copy(alpha = 0.92f), modifier = Modifier.padding(top = 6.dp))
                })
            }
            item {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(status == "open", { status = "open" }, label = { Text("Open") })
                    TICKET_STATUSES.forEach { (code, label) ->
                        FilterChip(status == code, { status = code }, label = { Text("$label · ${list?.counts?.get(code) ?: 0}") })
                    }
                    FilterChip(status == null, { status = null }, label = { Text("All") })
                }
            }
            item {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(type == null, { type = null }, label = { Text("All types") })
                    TICKET_TYPES.forEach { (code, label) -> FilterChip(type == code, { type = if (type == code) null else code }, label = { Text(label) }) }
                }
            }
            item {
                SectionCard {
                    val l = list
                    when {
                        l == null -> Loading(Modifier.height(80.dp))
                        l.tickets.isEmpty() -> EmptyNote("No tickets match.")
                        else -> l.tickets.forEachIndexed { i, t ->
                            TicketRow(t, true) { openTicket(t.id) }
                            if (i < l.tickets.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        }
                    }
                }
            }
        }
    }
}
