package com.activetogether.companion.ui

import android.graphics.Color as AColor
import android.graphics.drawable.GradientDrawable
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.activetogether.companion.ApiException
import com.activetogether.companion.Journey
import com.activetogether.companion.JourneyInput
import com.activetogether.companion.JourneyPlace
import com.activetogether.companion.JourneyPreview
import com.activetogether.companion.PlaceResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.osmdroid.events.MapEventsReceiver
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.BoundingBox
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.MapEventsOverlay
import org.osmdroid.views.overlay.Marker
import org.osmdroid.views.overlay.Polyline

private const val MAX_STOPS = 10

/** A place on the journey being set up. custom: the owner typed its label, so moving it keeps the name. */
data class DraftPlace(val name: String, val lat: Double, val lon: Double, val custom: Boolean = false)

/** The journey an owner is setting up: start, finish, stops (null while one is being searched for), how and which way. */
@Stable
class JourneyDraft(initial: Journey?) {
    var mode by mutableStateOf(initial?.mode ?: "foot")
    var shape by mutableStateOf(initial?.shape ?: "roads")
    var from by mutableStateOf(initial?.let { DraftPlace(it.fromName, it.fromLat, it.fromLon, custom = true) })
    var to by mutableStateOf(initial?.let { DraftPlace(it.toName, it.toLat, it.toLon, custom = true) })
    val via = mutableStateListOf<DraftPlace?>().apply { initial?.via?.forEach { add(DraftPlace(it.name, it.lat, it.lon, custom = true)) } }
    var preview by mutableStateOf<JourneyPreview?>(null)
    var status by mutableStateOf<String?>(null)
    var statusIsError by mutableStateOf(false)

    val cycling: Boolean get() = mode == "cycling"
    /** What's sent to the server, once there's a start and a finish. */
    fun value(): JourneyInput? {
        val f = from ?: return null; val t = to ?: return null
        fun p(x: DraftPlace) = JourneyPlace(x.name.ifBlank { "%.4f, %.4f".format(x.lat, x.lon) }, x.lat, x.lon)
        return JourneyInput(p(f), p(t), via.filterNotNull().map { p(it) }, shape, mode)
    }
    /** Changes that need the route planned again (not the labels). */
    fun routeKey(): String = listOf(from?.let { "${it.lat},${it.lon}" }, to?.let { "${it.lat},${it.lon}" },
        via.filterNotNull().joinToString(";") { "${it.lat},${it.lon}" }, shape, mode).joinToString("|")

    fun get(k: String): DraftPlace? = when (k) { "from" -> from; "to" -> to; else -> via.getOrNull(k.removePrefix("via").toInt()) }
    fun put(k: String, p: DraftPlace?) { when (k) { "from" -> from = p; "to" -> to = p; else -> via[k.removePrefix("via").toInt()] = p } }
}

private fun haversine(aLat: Double, aLon: Double, bLat: Double, bLon: Double): Double {
    val r = 6371000.0; val dLat = Math.toRadians(bLat - aLat); val dLon = Math.toRadians(bLon - aLon)
    val h = Math.sin(dLat / 2).let { it * it } + Math.cos(Math.toRadians(aLat)) * Math.cos(Math.toRadians(bLat)) * Math.sin(dLon / 2).let { it * it }
    return 2 * r * Math.asin(Math.sqrt(h))
}

/**
 * Setting up a virtual journey, as on the website: start and finish (and up to 10 stops) from a place search or a
 * tap on the map - the first tap sets the start, the next the finish, any more add a stop where it makes the least
 * detour. Each place can be relabelled. The route and its length are previewed as it changes.
 */
@Composable
fun JourneyEditor(vm: AppViewModel, draft: JourneyDraft, onModeChange: () -> Unit) {
    val scope = rememberCoroutineScope()
    var full by remember { mutableStateOf(false) }

    suspend fun nameAt(lat: Double, lon: Double): String =
        runCatching { withContext(Dispatchers.IO) { vm.api().placeName(lat, lon) } }.getOrNull() ?: "%.3f, %.3f".format(lat, lon)

    // A place picked from the search (with its name) or a tap (named by looking it up). An owner's own label survives a move.
    fun setPoint(k: String, lat: Double, lon: Double, name: String? = null) {
        val before = draft.get(k)
        val keep = before?.custom == true
        draft.put(k, DraftPlace(if (keep) before!!.name else name ?: "Finding the place name…", lat, lon, keep))
        if (!keep && name == null) scope.launch {
            val n = nameAt(lat, lon)
            draft.get(k)?.let { p -> if (!p.custom && p.lat == lat && p.lon == lon) draft.put(k, p.copy(name = n)) }
        }
    }
    fun tap(lat: Double, lon: Double) {
        val f = draft.from; val t = draft.to
        when {
            f == null -> setPoint("from", lat, lon)
            t == null -> setPoint("to", lat, lon)
            else -> {
                draft.via.removeAll { it == null }
                if (draft.via.size >= MAX_STOPS) { draft.status = "A journey can have up to $MAX_STOPS stops on the way."; draft.statusIsError = true; return }
                val pts = listOf(f) + draft.via.filterNotNull() + t
                val best = (0 until pts.size - 1).minByOrNull { i ->
                    haversine(pts[i].lat, pts[i].lon, lat, lon) + haversine(lat, lon, pts[i + 1].lat, pts[i + 1].lon) - haversine(pts[i].lat, pts[i].lon, pts[i + 1].lat, pts[i + 1].lon)
                } ?: 0
                draft.via.add(best, DraftPlace("", lat, lon))
                setPoint("via$best", lat, lon)
            }
        }
    }

    // Plan the route a moment after the last change.
    LaunchedEffect(draft.routeKey()) {
        val j = draft.value()
        if (j == null) { draft.preview = null; draft.status = "Choose a start and a finish."; draft.statusIsError = false; return@LaunchedEffect }
        draft.status = "Planning the route…"; draft.statusIsError = false
        delay(400)
        try {
            draft.preview = withContext(Dispatchers.IO) { vm.api().previewJourney(j) }
            draft.status = null
        } catch (e: ApiException) { draft.preview = null; draft.status = e.message; draft.statusIsError = true }
        catch (e: Exception) { draft.preview = null; draft.status = "Couldn't reach Active Together: ${e.message}"; draft.statusIsError = true }
    }

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Dropdown("Getting there", listOf("foot", "cycling"), draft.mode, { if (it == "cycling") "Cycling only" else "On foot" },
                { draft.mode = it; onModeChange() }, Modifier.weight(1f))
            Dropdown("Route", listOf("roads", "straight"), draft.shape, { if (it == "straight") "Straight line" else "Roads and paths" }, { draft.shape = it }, Modifier.weight(1f))
        }
        PlaceField(vm, "Start", draft.from, onPick = { draft.from = DraftPlace(it.name, it.lat, it.lon) },
            onLabel = { draft.from = draft.from?.copy(name = it, custom = it.isNotBlank()) })
        PlaceField(vm, "Finish", draft.to, onPick = { draft.to = DraftPlace(it.name, it.lat, it.lon) },
            onLabel = { draft.to = draft.to?.copy(name = it, custom = it.isNotBlank()) })
        draft.via.forEachIndexed { i, p ->
            val k = "via$i"
            PlaceField(vm, "Stop ${i + 1}", p, onPick = { draft.put(k, DraftPlace(it.name, it.lat, it.lon)) },
                onLabel = { v -> draft.get(k)?.let { draft.put(k, it.copy(name = v, custom = v.isNotBlank())) } },
                actions = {
                    IconButton(onClick = { draft.via.add(i - 1, draft.via.removeAt(i)) }, enabled = i > 0) { Icon(Icons.Default.ArrowUpward, "Earlier") }
                    IconButton(onClick = { draft.via.add(i + 1, draft.via.removeAt(i)) }, enabled = i < draft.via.lastIndex) { Icon(Icons.Default.ArrowDownward, "Later") }
                    IconButton(onClick = { draft.via.removeAt(i) }) { Icon(Icons.Default.Close, "Remove stop") }
                })
        }
        OutlinedButton(onClick = {
            if (draft.via.size >= MAX_STOPS) { draft.status = "A journey can have up to $MAX_STOPS stops on the way."; draft.statusIsError = true } else draft.via.add(null)
        }) { Text("+ Add a stop on the way") }
        EmptyNote("Or tap the map: the first tap sets the start, the next the finish, and any more add stops.")
        Box {
            JourneyPickerMap(draft, ::tap, Modifier.fillMaxWidth().height(300.dp))
            IconButton(onClick = { full = true }, modifier = Modifier.align(Alignment.TopEnd)) { Icon(Icons.Default.Fullscreen, "Full screen") }
        }
        val pv = draft.preview; val f = draft.from; val t = draft.to
        val summary = draft.status ?: if (pv != null && f != null && t != null) {
            val stops = draft.via.filterNotNull().takeIf { it.isNotEmpty() }?.joinToString(", ") { it.name }?.let { " via $it" }.orEmpty()
            "${f.name} → ${t.name}$stops: ${fmtLen(pv.miles)} miles (${fmtLen(pv.km)} km) ${if (draft.shape == "straight") "as the crow flies" else "by road"}, about ${fmtSteps(pv.steps)} steps"
        } else null
        summary?.let { Text(it, color = if (draft.statusIsError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyMedium) }
    }
    if (full) Dialog(onDismissRequest = { full = false }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize()) {
            JourneyPickerMap(draft, ::tap, Modifier.fillMaxSize())
            FilledTonalButton(onClick = { full = false }, modifier = Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(12.dp)) {
                Icon(Icons.Default.Close, null); Spacer(Modifier.width(6.dp)); Text("Done")
            }
        }
    }
}

private fun fmtLen(v: Double) = if (v >= 100) Math.round(v).toString() else fmtNum(Math.round(v * 10) / 10.0)

/** One place: a search box with its results, then (once picked) what the challenge calls it. */
@Composable
private fun PlaceField(vm: AppViewModel, label: String, place: DraftPlace?, onPick: (PlaceResult) -> Unit, onLabel: (String) -> Unit,
                       actions: (@Composable () -> Unit)? = null) {
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<List<PlaceResult>?>(null) }
    var note by remember { mutableStateOf<String?>(null) }
    fun find() {
        if (query.trim().length < 2) return
        note = "Searching…"; results = null
        scope.launch {
            try {
                val r = withContext(Dispatchers.IO) { vm.api().searchPlaces(query) }
                results = r; note = if (r.isEmpty()) "Nothing found - try another name, or tap the map." else null
            } catch (e: Exception) { note = e.message }
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            actions?.invoke()
        }
        OutlinedTextField(query, { query = it }, placeholder = { Text("Search for a place") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            trailingIcon = { IconButton(onClick = { find() }) { Icon(Icons.Default.Search, "Find") } },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { find() }))
        note?.let { EmptyNote(it) }
        results?.let { list ->
            list.forEachIndexed { i, p ->
                Text(p.detail, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.fillMaxWidth()
                    .clickable { results = null; query = ""; onPick(p) }.padding(vertical = 8.dp))
                if (i < list.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        }
        if (place != null) OutlinedTextField(place.name, { onLabel(it.take(120)) }, label = { Text("Shown as") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            supportingText = { Text("%.4f, %.4f".format(place.lat, place.lon)) })
    }
}

/** The map for setting up a journey: start, finish and numbered stops, the planned route, and taps to place them. */
@Composable
private fun JourneyPickerMap(draft: JourneyDraft, onTap: (Double, Double) -> Unit, modifier: Modifier) {
    val context = LocalContext.current
    val density = context.resources.displayMetrics.density
    val map = remember {
        configureOsm(context)
        MapView(context).apply {
            setTileSource(tileSource(context))
            setMultiTouchControls(true)
            zoomController.setVisibility(org.osmdroid.views.CustomZoomButtonsController.Visibility.NEVER)
            controller.setZoom(5.0); controller.setCenter(GeoPoint(54.0, -2.5))
            // Panning the map shouldn't scroll the page it sits in.
            setOnTouchListener { v, _ -> v.parent?.requestDisallowInterceptTouchEvent(true); false }
        }
    }
    DisposableEffect(map) { map.onResume(); onDispose { map.onPause(); map.onDetach() } }
    var framed by remember { mutableStateOf<String?>(null) }
    val tapRef = androidx.compose.runtime.rememberUpdatedState(onTap)
    AndroidView(factory = { map }, modifier = modifier.clipToBounds(), update = { view ->
        view.overlays.clear()
        view.overlays.add(MapEventsOverlay(object : MapEventsReceiver {
            override fun singleTapConfirmedHelper(p: GeoPoint): Boolean { tapRef.value(p.latitude, p.longitude); return true }
            override fun longPressHelper(p: GeoPoint): Boolean = false
        }))
        view.overlays.add(osmCredit(view))
        val f = draft.from; val t = draft.to; val stops = draft.via.filterNotNull()
        val line = draft.preview?.points?.map { GeoPoint(it.lat, it.lon) }
            ?: listOfNotNull(f, *stops.toTypedArray(), t).takeIf { f != null && t != null }?.map { GeoPoint(it.lat, it.lon) }
        if (line != null && line.size >= 2) view.overlays.add(Polyline(view).apply {
            setPoints(line); outlinePaint.color = AColor.rgb(0xD4, 0x05, 0x11); outlinePaint.strokeWidth = 4 * density
            if (draft.preview == null) outlinePaint.alpha = 90
        })
        fun dot(fill: Int, ring: Int, sizeDp: Int) = GradientDrawable().apply {
            shape = GradientDrawable.OVAL; setColor(fill); setStroke((3 * density).toInt(), ring); setSize((sizeDp * density).toInt(), (sizeDp * density).toInt())
        }
        stops.forEachIndexed { i, s ->
            val size = (22 * density).toInt()
            val bmp = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
            android.graphics.Canvas(bmp).apply {
                val p = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
                p.color = AColor.WHITE; drawCircle(size / 2f, size / 2f, size / 2f, p)
                p.color = AColor.rgb(0x17, 0x17, 0x17); drawCircle(size / 2f, size / 2f, size / 2f - 2 * density, p)
                p.color = AColor.WHITE; p.textSize = size * 0.55f; p.textAlign = android.graphics.Paint.Align.CENTER; p.isFakeBoldText = true
                drawText("${i + 1}", size / 2f, size / 2f - (p.descent() + p.ascent()) / 2, p)
            }
            view.overlays.add(Marker(view).apply {
                position = GeoPoint(s.lat, s.lon); title = "Stop ${i + 1}: ${s.name}"
                icon = android.graphics.drawable.BitmapDrawable(context.resources, bmp); setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_CENTER)
            })
        }
        f?.let { view.overlays.add(Marker(view).apply { position = GeoPoint(it.lat, it.lon); title = "Start: ${it.name}"; icon = dot(AColor.WHITE, AColor.rgb(0x17, 0x17, 0x17), 18); setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_CENTER) }) }
        t?.let { view.overlays.add(Marker(view).apply { position = GeoPoint(it.lat, it.lon); title = "Finish: ${it.name}"; icon = dot(AColor.rgb(0xD4, 0x05, 0x11), AColor.WHITE, 20); setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_CENTER) }) }
        // Frame the places when they (or the planned route) change - not while someone is panning around.
        val pts = line ?: listOfNotNull(f, t).map { GeoPoint(it.lat, it.lon) }
        val key = draft.routeKey() + (draft.preview != null)
        if (pts.isNotEmpty() && key != framed) {
            framed = key
            if (pts.size == 1) view.post { view.controller.setZoom(10.0); view.controller.setCenter(pts[0]) }
            else { val box = BoundingBox.fromGeoPoints(pts); view.post { view.zoomToBoundingBox(box.increaseByScale(1.3f), false) } }
        }
        view.invalidate()
    })
}
