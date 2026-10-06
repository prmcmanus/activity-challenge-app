package com.activetogether.companion.ui

import android.content.Context
import android.graphics.Color as AColor
import android.graphics.drawable.GradientDrawable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
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

/** OpenStreetMap needs an identifying user agent, and osmdroid caches tiles in the app's own cache. */
private fun configureOsm(context: Context) {
    val c = Configuration.getInstance()
    c.userAgentValue = "ActiveTogether/${context.packageName}"
    c.osmdroidBasePath = context.cacheDir.resolve("osmdroid")
    c.osmdroidTileCache = context.cacheDir.resolve("osmdroid/tiles")
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
    AndroidView(factory = { map }, modifier = modifier, update = { view ->
        view.overlays.clear()
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
