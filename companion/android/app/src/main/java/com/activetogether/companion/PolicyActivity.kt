package com.activetogether.companion

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.activetogether.companion.ui.ActiveTogetherTheme

/**
 * A page of the website inside the app (the privacy policy, by default), so reading it never sends anyone off
 * to the browser. The page is opened with ?in_app=1, which hides the site's own header and footer; links to
 * other pages of the site stay here, and anything else (an email address, another site) opens outside.
 */
class PolicyActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val path = intent.getStringExtra(EXTRA_PATH) ?: "/privacy.html"
        val title = intent.getStringExtra(EXTRA_TITLE) ?: "Privacy policy"
        setContent { ActiveTogetherTheme { PolicyScreen(title, inApp(Uri.parse("$SERVER_URL$path"))) { finish() } } }
    }

    companion object {
        private const val EXTRA_PATH = "path"
        private const val EXTRA_TITLE = "title"
        fun open(context: Context, path: String = "/privacy.html", title: String = "Privacy policy") =
            context.startActivity(Intent(context, PolicyActivity::class.java).putExtra(EXTRA_PATH, path).putExtra(EXTRA_TITLE, title))
    }
}

private fun inApp(u: Uri): String = if (u.getQueryParameter("in_app") != null) u.toString() else u.buildUpon().appendQueryParameter("in_app", "1").build().toString()

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PolicyScreen(title: String, url: String, close: () -> Unit) {
    var loading by remember { mutableStateOf(true) }
    var failed by remember { mutableStateOf(false) }
    Scaffold(topBar = {
        TopAppBar(title = { Text(title) }, navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } })
    }) { pad ->
        Box(Modifier.padding(pad).fillMaxSize()) {
            AndroidView(factory = { ctx ->
                WebView(ctx).apply {
                    settings.javaScriptEnabled = true // the page's light and dark themes
                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                            val u = request.url
                            if ((u.scheme == "https" || u.scheme == "http") && u.host == Uri.parse(SERVER_URL).host) {
                                if (u.getQueryParameter("in_app") != null) return false
                                view.loadUrl(inApp(u)); return true
                            }
                            runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, u)) }
                            return true
                        }
                        override fun onPageFinished(view: WebView, url: String) { loading = false }
                        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                            if (request.isForMainFrame) { failed = true; loading = false }
                        }
                    }
                    loadUrl(url)
                }
            }, modifier = Modifier.fillMaxSize())
            if (loading) CircularProgressIndicator(Modifier.align(Alignment.Center))
            if (failed) Text("Couldn't load the page. Check your connection and try again.", Modifier.align(Alignment.Center).padding(24.dp))
        }
    }
}
