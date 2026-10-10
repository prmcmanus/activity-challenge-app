package com.activetogether.companion

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Phone notifications (ticket replies, being added to a challenge, challenges starting and ending, a weekly summary)
 * through Firebase Cloud Messaging. Firebase is started with the details the server gives in /api/config, so the
 * app needs no google-services.json and nothing happens until the server is set up for it.
 */
object Push {
    const val CHANNEL = "updates"

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = context.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Challenge news", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Replies to your tickets, being added to a challenge, challenges starting and ending, and a weekly summary"
            })
    }

    /** Starts Firebase with the server's details (once) and hands back this phone's push token, or null. */
    fun token(context: Context, cfg: PushConfig, done: (String?) -> Unit) {
        try {
            if (FirebaseApp.getApps(context).isEmpty())
                FirebaseApp.initializeApp(context, FirebaseOptions.Builder().setApplicationId(cfg.appId).setApiKey(cfg.apiKey)
                    .setProjectId(cfg.projectId).setGcmSenderId(cfg.senderId).build())
            FirebaseMessaging.getInstance().token.addOnCompleteListener { t -> done(if (t.isSuccessful) t.result else null) }
        } catch (e: Exception) { done(null) }
    }

    /** A notification that opens the app at [url] (a challenge or a ticket) when tapped. */
    fun show(context: Context, title: String, body: String, url: String?) {
        ensureChannel(context)
        val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP).putExtra("url", url ?: "/")
        val pi = PendingIntent.getActivity(context, (url ?: title).hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_stat_notify).setContentTitle(title).setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body)).setAutoCancel(true).setContentIntent(pi)
            // On a locked phone, only that there's news - the text shows once it's unlocked.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(NotificationCompat.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_stat_notify).setContentTitle("Active Together").setContentText("New update").build())
            .build()
        runCatching { NotificationManagerCompat.from(context).notify((url ?: title).hashCode(), n) }
    }
}

/** Firebase's messages: a new token goes to the server; a message arriving while the app is open is shown here (when
 *  it's closed, Android shows it itself, and tapping it opens the app with the same "url"). */
class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        val prefs = Prefs(this)
        prefs.pushToken = token
        prefs.token?.let { t -> runCatching { ActiveTogetherApi(t).registerPush(token) } }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val n = message.notification
        Push.show(this, n?.title ?: message.data["title"] ?: "Active Together", n?.body ?: message.data["body"] ?: "", message.data["url"])
    }
}
