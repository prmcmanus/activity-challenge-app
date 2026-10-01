package com.activetogether.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.activetogether.companion.serverUrl
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

fun fmtDay(d: LocalDate): String = d.format(DateTimeFormatter.ofPattern("EEE d MMM", Locale.getDefault()))
fun fmtRange(a: LocalDate, b: LocalDate): String =
    if (a.year == b.year) "${a.format(DateTimeFormatter.ofPattern("d MMM", Locale.getDefault()))} – ${b.format(DateTimeFormatter.ofPattern("d MMM yyyy", Locale.getDefault()))}"
    else "${fmtDay(a)} ${a.year} – ${fmtDay(b)} ${b.year}"

/** Up to two decimals, no trailing zeros: 3, 3.1, 3.11. */
fun fmtNum(v: Double): String = if (v == Math.floor(v)) v.toLong().toString() else String.format(Locale.getDefault(), "%.2f", v).trimEnd('0').trimEnd('.', ',')

/** "12.4 mi" or "340 min" - whichever the challenge measures. */
fun fmtMeasure(measuresDistance: Boolean, minutes: Double, distance: Double, unit: String) =
    if (measuresDistance) "${fmtNum(distance)} ${if (unit == "km") "km" else "mi"}" else "${fmtNum(minutes)} min"

/** Challenge descriptions are sanitised HTML from the web editor; on the phone they read as plain text. */
fun htmlToText(html: String): String = androidx.core.text.HtmlCompat.fromHtml(html, androidx.core.text.HtmlCompat.FROM_HTML_MODE_COMPACT).toString().trim()

/** The red banner at the top of a page, matching the web app's hero. */
@Composable
fun Hero(eyebrow: String, title: String, modifier: Modifier = Modifier, trailing: (@Composable () -> Unit)? = null, below: (@Composable ColumnScope.() -> Unit)? = null) {
    Box(
        modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.large)
            .background(Brush.linearGradient(listOf(BrandRedDeep, BrandRed)))
            .padding(20.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(eyebrow.uppercase(), style = MaterialTheme.typography.labelSmall, color = Color.White.copy(alpha = 0.85f))
                Text(title, style = MaterialTheme.typography.headlineMedium, color = Color.White, modifier = Modifier.padding(top = 4.dp))
                below?.invoke(this)
            }
            trailing?.invoke()
        }
    }
}

/** The big number in the hero, e.g. "15.6 / my miles". */
@Composable
fun HeroStat(value: String, label: String) {
    Column(
        Modifier.clip(MaterialTheme.shapes.medium).background(Color.White.copy(alpha = 0.14f)).padding(horizontal = 18.dp, vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(value, color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.ExtraBold)
        Text(label, color = Color.White, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
fun SectionCard(title: String? = null, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.large,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
    ) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (title != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                    action?.invoke()
                }
            }
            content()
        }
    }
}

/** An uploaded avatar or logo, or the first letter on yellow - as on the web leaderboards. */
@Composable
fun Avatar(url: String?, name: String, size: Dp = 36.dp) {
    if (url != null) {
        AsyncImage(model = serverUrl(url), contentDescription = null, contentScale = ContentScale.Crop,
            modifier = Modifier.size(size).clip(CircleShape))
    } else {
        Box(Modifier.size(size).clip(CircleShape).background(BrandYellow), contentAlignment = Alignment.Center) {
            Text(name.take(1).uppercase(), color = BrandRed, fontWeight = FontWeight.ExtraBold, fontSize = (size.value * 0.42f).sp)
        }
    }
}

@Composable
fun Loading(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
}

@Composable
fun EmptyNote(text: String) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

val PagePadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 24.dp)

/** A read-only dropdown field: label, current value, and a menu of options. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun <T> Dropdown(label: String, options: List<T>, selected: T, display: (T) -> String, onSelect: (T) -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    var open by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { if (enabled) open = it }, modifier = modifier) {
        OutlinedTextField(
            value = display(selected), onValueChange = {}, readOnly = true, enabled = enabled, label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(open) },
            modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable, enabled).fillMaxWidth(),
            singleLine = true,
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { o -> DropdownMenuItem(text = { Text(display(o)) }, onClick = { onSelect(o); open = false }) }
        }
    }
}
