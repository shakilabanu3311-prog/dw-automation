package com.b2c.hisab

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.provider.Telephony
import android.widget.*
import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : Activity() {

    private lateinit var prefs: SharedPreferences
    private lateinit var statusView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("hisab", Context.MODE_PRIVATE)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 60, 40, 40)
        }

        val tvTitle = TextView(this).apply { text = "B2C Hisab — SMS Sync"; textSize = 20f }
        // Default points at the production Railway URL so first-time installs
        // work without manual config. The user can still override for local
        // dev (http://192.168.x.x:3000).
        val urlEt = EditText(this).apply {
            hint = "Server URL"
            setText(prefs.getString("url", "https://web-production-d340e.up.railway.app"))
        }
        val tokEt = EditText(this).apply {
            hint = "API token (web app → Settings → Tokens → New)"
            setText(prefs.getString("token", ""))
        }
        val saveBtn = Button(this).apply { text = "Save config" }
        val testBtn = Button(this).apply { text = "Test connection" }
        val permBtn = Button(this).apply { text = "Grant SMS permissions" }
        val notifBtn = Button(this).apply { text = "Grant Notification access" }
        val backfillBtn = Button(this).apply { text = "Backfill: send last 500 SMS" }
        statusView = TextView(this).apply { text = "Status: idle" }

        saveBtn.setOnClickListener {
            prefs.edit()
                .putString("url", urlEt.text.toString().trim())
                .putString("token", tokEt.text.toString().trim())
                .apply()
            Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show()
        }
        permBtn.setOnClickListener {
            if (Build.VERSION.SDK_INT >= 23) {
                requestPermissions(arrayOf(
                    Manifest.permission.READ_SMS,
                    Manifest.permission.RECEIVE_SMS,
                    Manifest.permission.POST_NOTIFICATIONS,
                ), 1)
            }
        }
        notifBtn.setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        backfillBtn.setOnClickListener { doBackfill() }
        testBtn.setOnClickListener {
            statusView.text = "Status: testing connection…"
            Thread {
                val url = (prefs.getString("url", "") ?: "").trimEnd('/')
                val token = prefs.getString("token", "") ?: ""
                if (url.isBlank()) {
                    runOnUiThread { statusView.text = "Set Server URL first, then Save config." }
                    return@Thread
                }
                try {
                    val conn = java.net.URL("$url/api/health").openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 8_000
                    conn.readTimeout = 8_000
                    val code = conn.responseCode
                    val body = (if (code in 200..299) conn.inputStream else conn.errorStream)
                        ?.bufferedReader()?.use { it.readText() } ?: ""
                    var msg = "Health: HTTP $code\n$body"
                    if (token.isNotBlank() && code == 200) {
                        // Hit the new diagnostics endpoint — bearer-only,
                        // returns the logged-in user. Clearer than the panel
                        // status check (which requires panel data).
                        val c2 = java.net.URL("$url/api/ingest/ping").openConnection() as java.net.HttpURLConnection
                        c2.setRequestProperty("Authorization", "Bearer $token")
                        c2.connectTimeout = 8_000
                        val code2 = c2.responseCode
                        val body2 = (if (code2 in 200..299) c2.inputStream else c2.errorStream)
                            ?.bufferedReader()?.use { it.readText() } ?: ""
                        msg += "\n\nToken check: HTTP $code2 ${if (code2 == 200) "(OK)" else "(invalid/expired token — re-mint in web app)"}\n$body2"
                        // ALSO run a no-op SMS ping so we know the SMS pipeline itself is reachable.
                        val c3 = java.net.URL("$url/api/ingest/sms").openConnection() as java.net.HttpURLConnection
                        c3.requestMethod = "POST"
                        c3.doOutput = true
                        c3.setRequestProperty("Content-Type", "application/json")
                        c3.setRequestProperty("Authorization", "Bearer $token")
                        c3.connectTimeout = 8_000
                        c3.outputStream.use { it.write("{\"messages\":[]}".toByteArray()) }
                        val code3 = c3.responseCode
                        val body3 = (if (code3 in 200..299) c3.inputStream else c3.errorStream)
                            ?.bufferedReader()?.use { it.readText() } ?: ""
                        msg += "\n\nSMS endpoint: HTTP $code3\n$body3"
                    }
                    runOnUiThread { statusView.text = msg }
                } catch (e: Exception) {
                    runOnUiThread { statusView.text = "FAIL: ${e.javaClass.simpleName}: ${e.message}\n\nIf 'CleartextNotPermitted', rebuild the APK with the new manifest.\nIf 'Connection refused' / timeout, check that the phone & PC are on the same Wi-Fi and Windows firewall allows port 3000." }
                }
            }.start()
        }

        listOf(tvTitle, urlEt, tokEt, saveBtn, testBtn, permBtn, notifBtn, backfillBtn, statusView).forEach {
            root.addView(it, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = 20 })
        }
        setContentView(root)

        // Kick off the periodic backfill (idempotent — KEEP policy)
        BackfillWorker.enqueue(applicationContext)
    }

    private fun doBackfill() {
        statusView.text = "Status: reading SMS…"
        if (checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this, "Grant SMS permission first", Toast.LENGTH_LONG).show(); return
        }
        val cursor = contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE),
            null, null, Telephony.Sms.DATE + " DESC LIMIT 500"
        )
        val arr = JSONArray()
        cursor?.use {
            while (it.moveToNext()) {
                val obj = JSONObject()
                    .put("sender", it.getString(0) ?: "")
                    .put("body", it.getString(1) ?: "")
                    .put("ts", java.util.Date(it.getLong(2)).toInstant().toString())
                arr.put(obj)
            }
        }
        val payload = JSONObject().put("messages", arr)
        Thread {
            try {
                val r = ApiClient.post(this, "/api/ingest/sms", payload)
                runOnUiThread { statusView.text = "Backfill result:\n$r" }
            } catch (e: Exception) {
                runOnUiThread { statusView.text = "Error: ${e.message}" }
            }
        }.start()
    }
}
