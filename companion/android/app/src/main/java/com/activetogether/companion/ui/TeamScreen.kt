package com.activetogether.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.activetogether.companion.TeamPage
import com.activetogether.companion.Totals
import kotlinx.coroutines.launch
import java.time.format.TextStyle
import java.util.Locale

/** A team's own page, opened from its name anywhere: its place and totals, the last fortnight, everyone's share, latest entries. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TeamScreen(vm: AppViewModel, teamId: Int, manageTeam: (Int, Int) -> Unit, openProfile: (Int) -> Unit) {
    val scope = rememberCoroutineScope()
    var page by remember { mutableStateOf<TeamPage?>(null) }
    var loading by remember { mutableStateOf(true) }
    var missing by remember { mutableStateOf(false) }
    fun load() = scope.launch {
        loading = true
        val p = vm.call { it.team(teamId) }
        if (p != null) page = p else missing = page == null
        loading = false
    }
    LaunchedEffect(teamId) { load() }
    PullToRefreshBox(modifier = Modifier.fillMaxSize(), isRefreshing = loading && page != null, onRefresh = { load() }) {
        val t = page
        if (t == null) { if (missing) LazyColumn(Modifier.fillMaxSize(), contentPadding = PagePadding) { item { SectionCard { EmptyNote("This team isn't available.") } } } else Loading(); return@PullToRefreshBox }
        val amount = { x: Totals -> fmtMeasure(t.measuresDistance, x.minutes, x.distance, t.distanceUnit, t.measuresSteps, x.steps) }
        val value = { x: Totals -> if (t.measuresSteps) x.steps else if (t.measuresDistance) x.distance else x.minutes }
        val inChallenge = vm.challenges.any { it.id == t.challengeId && it.role != "admin" }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PagePadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Hero(t.challengeName, t.name,
                    trailing = { if (t.rank > 0) HeroStat(ordinal(t.rank), "of ${t.of} teams") },
                    below = {
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 10.dp)) {
                            Avatar(t.imageUrl, t.name, 56.dp)
                            Spacer(Modifier.width(12.dp))
                            Column {
                                Text(listOfNotNull("${t.members} member${if (t.members == 1) "" else "s"}", if (t.mine) "your team" else null).joinToString(" · "),
                                    color = Color.White, style = MaterialTheme.typography.bodyMedium)
                                Text("Open the challenge", color = Color.White, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold,
                                    modifier = Modifier.clickable { vm.openChallenge(t.challengeId) })
                            }
                        }
                    })
            }
            if ((!t.mine && inChallenge) || t.canManage) item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (!t.mine && inChallenge) Button(onClick = { scope.launch { vm.joinTeam(t.challengeId, t.id); load() } }) { Text("Join this team") }
                    if (t.canManage) OutlinedButton(onClick = { manageTeam(t.challengeId, t.id) }) { Text("Manage") }
                }
            }
            item {
                SectionCard("Progress") {
                    val tiles = listOfNotNull("all time" to t.total, "this month" to t.month, "this week" to t.week,
                        t.people.count { !it.former }.takeIf { it > 0 }?.let { n -> "per member" to Totals(Math.round(t.total.minutes / n).toDouble(), Math.round(t.total.distance / n * 100) / 100.0, Math.round(t.total.steps / n).toDouble()) })
                    tiles.chunked(2).forEach { pair ->
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            pair.forEach { (label, x) ->
                                Column(Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceVariant).padding(horizontal = 12.dp, vertical = 10.dp)) {
                                    Text(amount(x), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                                    Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                            if (pair.size == 1) Spacer(Modifier.weight(1f))
                        }
                    }
                    // On a journey: how far along the route, and what's next.
                    t.progress?.let { p ->
                        Text("On the journey", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 4.dp))
                        LinearProgressIndicator(progress = { p.toFloat() }, modifier = Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)))
                        Text(t.finishedOn?.let { "🏁 Finished on $it" } ?: ("${Math.round(p * 100)}% of the way" +
                            (t.nextName?.let { n -> " · ${t.nextRemaining?.let { r -> if (r >= 10) Math.round(r).toString() else fmtNum(r) } ?: ""} ${t.journeyUnit ?: ""} to $n" } ?: "")),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            // The last fortnight of the challenge so far, a bar a day.
            if (t.days.isNotEmpty()) item {
                SectionCard(if (t.days.size == 14) "The last fortnight" else "The last ${t.days.size} day${if (t.days.size == 1) "" else "s"}") {
                    val top = t.days.maxOf { value(it.total) }.coerceAtLeast(1.0)
                    Row(Modifier.fillMaxWidth().height(110.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.Bottom) {
                        t.days.forEach { d ->
                            Column(Modifier.weight(1f).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Bottom) {
                                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.BottomCenter) {
                                    Box(Modifier.fillMaxWidth().fillMaxHeight((value(d.total) / top).toFloat().coerceAtLeast(0.02f))
                                        .clip(RoundedCornerShape(topStart = 3.dp, topEnd = 3.dp)).background(MaterialTheme.colorScheme.primary))
                                }
                                Text(d.date.dayOfWeek.getDisplayName(TextStyle.NARROW, Locale.getDefault()), style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                            }
                        }
                    }
                    val best = t.days.maxBy { value(it.total) }
                    if (value(best.total) > 0) Text("Best day: ${fmtDay(best.date)}, ${amount(best.total)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            item {
                SectionCard("Members") {
                    if (t.people.isEmpty()) EmptyNote("Nobody in this team yet.")
                    var place = 0
                    t.people.forEachIndexed { i, m ->
                        Row(Modifier.fillMaxWidth().clickable { openProfile(m.id) }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(if (m.former) "" else "${++place}", fontWeight = FontWeight.Black,
                                color = if (place <= 3) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(30.dp))
                            Avatar(m.avatarUrl, m.name)
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(m.name + if (m.id == vm.me?.id) " (you)" else "", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
                                Text(listOfNotNull(if (m.former) "left the team" else if (m.teamAdmin) "team admin" else null, "${amount(m.week)} this week").joinToString(" · "),
                                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Column(horizontalAlignment = Alignment.End, modifier = Modifier.width(110.dp)) {
                                Text(amount(m.total), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                                LinearProgressIndicator(progress = { m.share.toFloat() }, modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp).height(5.dp).clip(RoundedCornerShape(3.dp)))
                                Text("${Math.round(m.share * 100)}% of the team", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        if (i < t.people.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    }
                }
            }
            if (t.activities.isNotEmpty()) item {
                var feed by remember(t) { mutableStateOf(t.activities) }
                SectionCard("Latest entries") {
                    EmptyNote("Yours, and from people who share their full activity.")
                    feed.forEachIndexed { i, e ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Avatar(e.avatarUrl, e.name)
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(e.name, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.clickable { openProfile(e.userId) })
                                Text(listOfNotNull(e.type, fmtDay(e.date), e.comment?.let { "“$it”" }).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Text(fmtMeasure(t.measuresDistance, e.minutes ?: 0.0, e.distance ?: 0.0, t.distanceUnit, t.measuresSteps, (e.steps ?: 0).toDouble()), fontWeight = FontWeight.Bold)
                            if (e.userId == vm.me?.id) { if (e.kudos > 0) Text("  👏 ${e.kudos}", style = MaterialTheme.typography.bodySmall) }
                            else KudosButton(vm, e.id, e.kudos, e.kudosMine) { n, mine -> feed = feed.map { x -> if (x.id == e.id) x.copy(kudos = n, kudosMine = mine) else x } }
                        }
                        if (i < feed.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    }
                }
            }
        }
    }
}
