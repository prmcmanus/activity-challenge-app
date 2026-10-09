package com.activetogether.companion.ui

import android.content.Context
import android.graphics.Color as AColor
import android.graphics.drawable.GradientDrawable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import com.activetogether.companion.RoutePoint
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.BoundingBox
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Marker
import org.osmdroid.views.overlay.Polyline

/**
 * OpenStreetMap's tile policy: an identifying user agent with a way to reach us, and the map credited on the
 * map itself (see [osmCredit]). osmdroid caches tiles in the app's own cache, as the policy asks.
 */
private fun configureOsm(context: Context) {
    val c = Configuration.getInstance()
    c.userAgentValue = "ActiveTogether/${com.activetogether.companion.BuildConfig.VERSION_NAME} (${context.packageName}; +https://activetogether.team)"
    c.osmdroidBasePath = context.cacheDir.resolve("osmdroid")
    c.osmdroidTileCache = context.cacheDir.resolve("osmdroid/tiles")
}

/** "© OpenStreetMap contributors" in the map's bottom corner, as its licence asks. */
private fun osmCredit(view: MapView) = org.osmdroid.views.overlay.CopyrightOverlay(view.context).apply {
    setAlignBottom(true); setAlignRight(true); setTextSize(10)
}

/** A route drawn in the app's red over OpenStreetMap, framed to fit, with start and finish markers. */
@Composable
fun RouteMap(points: List<RoutePoint>, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val map = remember {
        configureOsm(context)
        MapView(context).apply {
            setTileSource(TileSourceFactory.MAPNIK)
            setMultiTouchControls(true)
            zoomController.setVisibility(org.osmdroid.views.CustomZoomButtonsController.Visibility.NEVER)
        }
    }
    DisposableEffect(map) {
        map.onResume()
        onDispose { map.onPause(); map.onDetach() }
    }
    AndroidView(factory = { map }, modifier = modifier.clipToBounds(), update = { view ->
        view.overlays.clear()
        view.overlays.add(osmCredit(view))
        val geo = points.map { GeoPoint(it.lat, it.lon) }
        if (geo.size < 2) return@AndroidView
        view.overlays.add(Polyline(view).apply {
            setPoints(geo)
            outlinePaint.color = AColor.rgb(0xD4, 0x05, 0x11)
            outlinePaint.strokeWidth = 10f
        })
        // Plain dots, as on the web map: green start, dark finish, white ring so they show on any tile.
        fun dot(fill: Int) = GradientDrawable().apply {
            shape = GradientDrawable.OVAL; setColor(fill); setStroke(6, AColor.WHITE); setSize(44, 44)
        }
        fun marker(p: GeoPoint, title: String, fill: Int) = Marker(view).apply {
            position = p; this.title = title; icon = dot(fill); setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_CENTER)
        }
        view.overlays.add(marker(geo.last(), "Finish", AColor.rgb(0x17, 0x17, 0x17)))
        view.overlays.add(marker(geo.first(), "Start", AColor.rgb(0x1A, 0x7F, 0x37)))
        val box = BoundingBox.fromGeoPoints(geo)
        // Frame once the view has a size; zoomToBoundingBox needs real dimensions.
        view.post { view.zoomToBoundingBox(box.increaseByScale(1.25f), false) }
        view.invalidate()
    })
}

/** A round marker face: the photo (or team logo) cropped to a circle, or the name's initial on yellow. */
private fun faceBitmap(name: String, photo: android.graphics.Bitmap?, sizePx: Int, finished: Boolean): android.graphics.Bitmap {
    val out = android.graphics.Bitmap.createBitmap(sizePx, sizePx, android.graphics.Bitmap.Config.ARGB_8888)
    val canvas = android.graphics.Canvas(out)
    val r = sizePx / 2f
    val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
    paint.color = if (finished) AColor.rgb(0xFF, 0xCC, 0x00) else AColor.WHITE
    canvas.drawCircle(r, r, r, paint)
    val inner = r - sizePx * 0.08f
    if (photo != null) {
        val scale = (inner * 2) / minOf(photo.width, photo.height)
        val m = android.graphics.Matrix().apply {
            setScale(scale, scale)
            postTranslate(r - photo.width * scale / 2, r - photo.height * scale / 2)
        }
        paint.shader = android.graphics.BitmapShader(photo, android.graphics.Shader.TileMode.CLAMP, android.graphics.Shader.TileMode.CLAMP).apply { setLocalMatrix(m) }
        canvas.drawCircle(r, r, inner, paint)
        paint.shader = null
    } else {
        paint.color = AColor.rgb(0xFF, 0xCC, 0x00); canvas.drawCircle(r, r, inner, paint)
        paint.color = AColor.rgb(0xD4, 0x05, 0x11); paint.textSize = sizePx * 0.42f; paint.textAlign = android.graphics.Paint.Align.CENTER
        paint.isFakeBoldText = true
        canvas.drawText(name.take(1).uppercase(), r, r - (paint.descent() + paint.ascent()) / 2, paint)
    }
    return out
}

/**
 * A virtual journey: the route, a ring at the start and a chequered flag at the finish, and each team's logo
 * or person's photo at their virtual position. Markers sharing a spot fan out round it; tapping one shows
 * the name and [describe]'s line (their total and progress).
 */
@Composable
fun JourneyMapView(journey: com.activetogether.companion.JourneyMap, describe: (com.activetogether.companion.JourneyMarker) -> String, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val map = remember {
        configureOsm(context)
        MapView(context).apply {
            setTileSource(TileSourceFactory.MAPNIK)
            setMultiTouchControls(true)
            zoomController.setVisibility(org.osmdroid.views.CustomZoomButtonsController.Visibility.NEVER)
        }
    }
    DisposableEffect(map) {
        map.onResume()
        onDispose { map.onPause(); map.onDetach() }
    }
    // Photos are fetched once (through Coil's cache) and drawn into the markers when they arrive.
    var photos by androidx.compose.runtime.remember(journey) { androidx.compose.runtime.mutableStateOf<Map<Int, android.graphics.Bitmap>>(emptyMap()) }
    androidx.compose.runtime.LaunchedEffect(journey) {
        val loader = coil.ImageLoader(context)
        val got = mutableMapOf<Int, android.graphics.Bitmap>()
        for (m in journey.markers) {
            val url = com.activetogether.companion.serverUrl(m.imageUrl) ?: continue
            val result = runCatching { loader.execute(coil.request.ImageRequest.Builder(context).data(url).size(160).allowHardware(false).build()) }.getOrNull()
            ((result as? coil.request.SuccessResult)?.drawable as? android.graphics.drawable.BitmapDrawable)?.bitmap?.let { got[m.id] = it }
        }
        photos = got
    }
    val density = context.resources.displayMetrics.density
    AndroidView(factory = { map }, modifier = modifier.clipToBounds(), update = { view ->
        view.overlays.clear()
        view.overlays.add(osmCredit(view))
        val geo = journey.route.map { GeoPoint(it.lat, it.lon) }
        if (geo.size < 2) return@AndroidView
        view.overlays.add(Polyline(view).apply {
            setPoints(geo)
            outlinePaint.color = AColor.rgb(0xD4, 0x05, 0x11)
            outlinePaint.strokeWidth = 10f
        })
        val j = journey.journey
        view.overlays.add(Marker(view).apply {
            position = GeoPoint(j.fromLat, j.fromLon); title = "Start: ${j.fromName}"
            icon = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(AColor.WHITE); setStroke((5 * density).toInt(), AColor.rgb(0x17, 0x17, 0x17)); setSize((18 * density).toInt(), (18 * density).toInt()) }
            setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_CENTER)
        })
        view.overlays.add(Marker(view).apply {
            position = GeoPoint(j.toLat, j.toLon); title = "Finish: ${j.toName}"
            val size = (28 * density).toInt()
            val flag = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
            android.graphics.Canvas(flag).drawText("🏁", 0f, size * 0.85f, android.graphics.Paint().apply { textSize = size * 0.85f })
            icon = android.graphics.drawable.BitmapDrawable(context.resources, flag)
            setAnchor(0.2f, 0.95f)
        })
        // Stops on the way: numbered dark dots.
        j.via.forEachIndexed { i, s ->
            val size = (22 * density).toInt()
            val dot = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
            android.graphics.Canvas(dot).apply {
                val p = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
                p.color = AColor.WHITE; drawCircle(size / 2f, size / 2f, size / 2f, p)
                p.color = AColor.rgb(0x17, 0x17, 0x17); drawCircle(size / 2f, size / 2f, size / 2f - 2 * density, p)
                p.color = AColor.WHITE; p.textSize = size * 0.55f; p.textAlign = android.graphics.Paint.Align.CENTER; p.isFakeBoldText = true
                drawText("${i + 1}", size / 2f, size / 2f - (p.descent() + p.ascent()) / 2, p)
            }
            view.overlays.add(Marker(view).apply {
                position = GeoPoint(s.lat, s.lon); title = "Stop ${i + 1}: ${s.name}"
                icon = android.graphics.drawable.BitmapDrawable(context.resources, dot); setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_CENTER)
            })
        }
        val face = (40 * density).toInt()
        journey.markers.groupBy { "%.3f,%.3f".format(it.lat, it.lon) }.values.forEach { group ->
            group.forEachIndexed { i, m ->
                val spread = if (group.size > 1) (20 + group.size * 2) * density else 0f
                val a = 2 * Math.PI * i / group.size
                val dx = (spread * Math.cos(a)).toFloat() / face; val dy = (spread * Math.sin(a)).toFloat() / face
                view.overlays.add(Marker(view).apply {
                    position = GeoPoint(m.lat, m.lon); title = m.name; snippet = describe(m)
                    icon = android.graphics.drawable.BitmapDrawable(context.resources, faceBitmap(m.name, photos[m.id], face, m.finishedOn != null))
                    setAnchor(0.5f - dx, 0.5f - dy)
                })
            }
        }
        val box = BoundingBox.fromGeoPoints(geo)
        view.post { view.zoomToBoundingBox(box.increaseByScale(1.3f), false) }
        view.invalidate()
    })
}
