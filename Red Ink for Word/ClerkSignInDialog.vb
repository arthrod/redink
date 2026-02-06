' Part of "Red Ink for Word"
' Copyright (c) LawDigital Ltd., Switzerland. All rights reserved. For license to use see https://redink.ai.
'
' =============================================================================
' File: ClerkSignInDialog.vb
' Purpose: WinForms dialog hosting a WebView2 control that loads a small HTML page
'          with Clerk.js SDK for user sign-in. After successful authentication,
'          the JavaScript sends the session data back to .NET via
'          WebView2.CoreWebView2.WebMessageReceived.
'
' Architecture:
'  - The dialog embeds a local HTML page (generated at runtime) that includes
'    Clerk's JavaScript SDK loaded from their CDN.
'  - Clerk.js handles the entire sign-in UI (email, password, social logins, etc.).
'  - On successful sign-in, a JavaScript callback posts the session token and user
'    metadata back to .NET via window.chrome.webview.postMessage().
'  - The dialog closes and returns a ClerkSignInResult to the caller.
'  - The HTML is loaded via NavigateToString (no external hosting required).
' =============================================================================

Option Strict On
Option Explicit On

Imports System.Windows.Forms
Imports Microsoft.Web.WebView2.Core
Imports Microsoft.Web.WebView2.WinForms
Imports Newtonsoft.Json.Linq
Imports SharedLibrary.SharedLibrary

Public Class ClerkSignInDialog
    Inherits Form

    Private WithEvents webView As WebView2
    Private _publishableKey As String
    Private _clerkDomain As String
    Private _result As ClerkSignInResult

    ''' <summary>
    ''' Shows the Clerk sign-in dialog and returns the result.
    ''' Returns Nothing if the user cancelled or an error occurred.
    ''' </summary>
    ''' <param name="publishableKey">Clerk publishable key (pk_test_... or pk_live_...).</param>
    ''' <param name="clerkDomain">Clerk domain (e.g., "your-app.clerk.accounts.dev").</param>
    ''' <returns>Sign-in result, or Nothing if cancelled.</returns>
    Public Shared Function ShowSignIn(publishableKey As String, clerkDomain As String) As ClerkSignInResult
        Using dialog As New ClerkSignInDialog(publishableKey, clerkDomain)
            dialog.ShowDialog()
            Return dialog._result
        End Using
    End Function

    Private Sub New(publishableKey As String, clerkDomain As String)
        _publishableKey = publishableKey
        _clerkDomain = clerkDomain
        _result = Nothing

        ' Form setup
        Me.Text = "Sign In — Red Ink"
        Me.Width = 500
        Me.Height = 700
        Me.StartPosition = FormStartPosition.CenterScreen
        Me.FormBorderStyle = FormBorderStyle.FixedDialog
        Me.MaximizeBox = False
        Me.MinimizeBox = False
        Me.ShowInTaskbar = False

        ' WebView2 setup
        webView = New WebView2()
        webView.Dock = DockStyle.Fill
        Me.Controls.Add(webView)
    End Sub

    Protected Overrides Async Sub OnLoad(e As EventArgs)
        MyBase.OnLoad(e)

        Try
            ' Initialize WebView2 with a user data folder in temp
            Dim userDataFolder = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "RedInk_ClerkAuth")
            Dim env = Await CoreWebView2Environment.CreateAsync(Nothing, userDataFolder).ConfigureAwait(True)
            Await webView.EnsureCoreWebView2Async(env).ConfigureAwait(True)

            ' Listen for messages from the page
            AddHandler webView.CoreWebView2.WebMessageReceived, AddressOf OnWebMessageReceived

            ' Load the sign-in HTML
            Dim html = GenerateSignInHtml(_publishableKey, _clerkDomain)
            webView.CoreWebView2.NavigateToString(html)
        Catch ex As Exception
            MessageBox.Show($"Could not initialize sign-in: {ex.Message}", "Sign In Error",
                            MessageBoxButtons.OK, MessageBoxIcon.Error)
            Me.Close()
        End Try
    End Sub

    ''' <summary>
    ''' Handles messages posted from JavaScript via window.chrome.webview.postMessage().
    ''' </summary>
    Private Sub OnWebMessageReceived(sender As Object, e As CoreWebView2WebMessageReceivedEventArgs)
        Try
            Dim message = e.WebMessageAsJson
            Dim obj = JObject.Parse(message)
            Dim msgType = obj.Value(Of String)("type")

            Select Case msgType
                Case "signInComplete"
                    _result = New ClerkSignInResult() With {
                        .SessionToken = obj.Value(Of String)("sessionToken"),
                        .SessionId = obj.Value(Of String)("sessionId"),
                        .UserId = obj.Value(Of String)("userId"),
                        .UserEmail = obj.Value(Of String)("email"),
                        .UserName = obj.Value(Of String)("name"),
                        .TokenExpiry = obj.Value(Of Long)("expiry")
                    }
                    Me.DialogResult = DialogResult.OK
                    Me.Close()

                Case "signInCancelled"
                    _result = Nothing
                    Me.DialogResult = DialogResult.Cancel
                    Me.Close()

                Case "signInError"
                    Dim errorMsg = obj.Value(Of String)("message")
                    MessageBox.Show($"Sign-in error: {errorMsg}", "Sign In",
                                    MessageBoxButtons.OK, MessageBoxIcon.Warning)
            End Select
        Catch
            ' Ignore malformed messages
        End Try
    End Sub

    Protected Overrides Sub OnFormClosing(e As FormClosingEventArgs)
        MyBase.OnFormClosing(e)
        Try
            If webView IsNot Nothing AndAlso webView.CoreWebView2 IsNot Nothing Then
                RemoveHandler webView.CoreWebView2.WebMessageReceived, AddressOf OnWebMessageReceived
            End If
        Catch
        End Try
    End Sub

    Protected Overrides Sub Dispose(disposing As Boolean)
        If disposing Then
            If webView IsNot Nothing Then
                webView.Dispose()
                webView = Nothing
            End If
        End If
        MyBase.Dispose(disposing)
    End Sub

    ''' <summary>
    ''' Generates the HTML page that loads Clerk.js and handles sign-in.
    ''' </summary>
    Private Shared Function GenerateSignInHtml(publishableKey As String, clerkDomain As String) As String
        ' Escape for safe embedding in HTML/JS
        Dim escapedKey = publishableKey.Replace("'", "\'").Replace("""", "&quot;")
        Dim escapedDomain = clerkDomain.Replace("'", "\'").Replace("""", "&quot;")

        Return $"<!DOCTYPE html>
<html>
<head>
    <meta charset='utf-8'>
    <meta name='viewport' content='width=device-width, initial-scale=1'>
    <title>Sign In — Red Ink</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f5f5;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: flex-start;
            min-height: 100vh;
            padding: 20px;
        }}
        h1 {{
            color: #333;
            margin-bottom: 10px;
            font-size: 22px;
        }}
        .subtitle {{
            color: #666;
            margin-bottom: 20px;
            font-size: 14px;
        }}
        #clerk-signin {{
            width: 100%;
            max-width: 420px;
        }}
        .loading {{
            color: #999;
            font-size: 14px;
            margin-top: 40px;
        }}
        .error {{
            color: #d32f2f;
            font-size: 14px;
            margin-top: 20px;
            padding: 12px;
            background: #ffebee;
            border-radius: 4px;
        }}
        .cancel-link {{
            margin-top: 20px;
            color: #666;
            cursor: pointer;
            text-decoration: underline;
            font-size: 13px;
        }}
    </style>
</head>
<body>
    <h1>Red Ink</h1>
    <p class='subtitle'>Sign in to continue</p>
    <div id='clerk-signin'></div>
    <p class='loading' id='loading'>Loading sign-in...</p>
    <p class='error' id='error' style='display:none'></p>
    <p class='cancel-link' onclick='cancelSignIn()'>Cancel</p>

    <script>
        // Notify .NET of cancellation
        function cancelSignIn() {{
            window.chrome.webview.postMessage(JSON.stringify({{ type: 'signInCancelled' }}));
        }}

        function showError(msg) {{
            document.getElementById('loading').style.display = 'none';
            var el = document.getElementById('error');
            el.textContent = msg;
            el.style.display = 'block';
            window.chrome.webview.postMessage(JSON.stringify({{ type: 'signInError', message: msg }}));
        }}
    </script>

    <!-- Load Clerk.js from CDN -->
    <script
        data-clerk-publishable-key='{escapedKey}'
        src='https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js'
        crossorigin='anonymous'
        onload='initClerk()'
        onerror='showError(""Failed to load Clerk. Check your internet connection."")'>
    </script>

    <script>
        async function initClerk() {{
            try {{
                document.getElementById('loading').style.display = 'none';

                const clerk = window.Clerk;
                if (!clerk) {{
                    showError('Clerk SDK not loaded.');
                    return;
                }}

                await clerk.load();

                // If already signed in, report immediately
                if (clerk.user) {{
                    reportSignIn(clerk);
                    return;
                }}

                // Mount the sign-in component
                clerk.mountSignIn(document.getElementById('clerk-signin'), {{
                    afterSignInUrl: '/',
                    appearance: {{
                        elements: {{
                            rootBox: {{ width: '100%' }}
                        }}
                    }}
                }});

                // Listen for sign-in completion
                clerk.addListener(function(event) {{
                    if (clerk.user && clerk.session) {{
                        reportSignIn(clerk);
                    }}
                }});

            }} catch (e) {{
                showError('Sign-in initialization failed: ' + e.message);
            }}
        }}

        async function reportSignIn(clerk) {{
            try {{
                var token = await clerk.session.getToken();
                var expiry = Math.floor(Date.now() / 1000) + 3600; // Default 1 hour

                window.chrome.webview.postMessage(JSON.stringify({{
                    type: 'signInComplete',
                    sessionToken: token,
                    sessionId: clerk.session.id,
                    userId: clerk.user.id,
                    email: clerk.user.primaryEmailAddress ? clerk.user.primaryEmailAddress.emailAddress : '',
                    name: (clerk.user.firstName || '') + ' ' + (clerk.user.lastName || ''),
                    expiry: expiry
                }}));
            }} catch (e) {{
                showError('Failed to retrieve session: ' + e.message);
            }}
        }}
    </script>
</body>
</html>"
    End Function

End Class
