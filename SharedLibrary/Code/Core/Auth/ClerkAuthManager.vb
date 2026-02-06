' Part of "Red Ink" (SharedLibrary)
' Copyright (c) LawDigital Ltd., Switzerland. All rights reserved. For license to use see https://redink.ai.
'
' =============================================================================
' File: ClerkAuthManager.vb
' Purpose: Central orchestrator for Clerk authentication lifecycle including
'          initialization from cached tokens, sign-in/sign-out flows, and
'          populating the shared context with auth state.
'
' Architecture:
'  - On initialization, checks for a cached token in ClerkTokenStore.
'    If valid (not expired), populates the SharedContext auth properties silently.
'    If expired, clears stored data (user must re-authenticate).
'  - Sign-in: Invokes the sign-in dialog callback (provided by the host project)
'    to get a session token via WebView2. On success, verifies the token with
'    Clerk Backend API, fetches user info, stores everything, and updates context.
'  - Sign-out: Clears token store and resets context auth properties.
'  - Thread-safe: All SharedContext updates happen on the calling thread.
' =============================================================================

Option Strict On
Option Explicit On

Imports System.Threading.Tasks
Imports SharedLibrary.SharedLibrary.SharedContext

Namespace SharedLibrary

    ''' <summary>
    ''' Authentication lifecycle manager for Clerk integration.
    ''' </summary>
    Public Class ClerkAuthManager

        Private ReadOnly _context As ISharedContext
        Private ReadOnly _tokenStore As ClerkTokenStore
        Private _apiClient As ClerkApiClient

        ''' <summary>
        ''' Delegate type for the sign-in dialog. The host project provides a callback
        ''' that opens a WebView2 dialog and returns the sign-in result.
        ''' </summary>
        ''' <param name="publishableKey">Clerk publishable key for the sign-in page.</param>
        ''' <param name="clerkDomain">Clerk domain (e.g., "your-app.clerk.accounts.dev").</param>
        ''' <returns>Sign-in result with session token and metadata, or Nothing if cancelled.</returns>
        Public Delegate Function SignInDialogCallback(publishableKey As String, clerkDomain As String) As ClerkSignInResult

        Private ReadOnly _signInCallback As SignInDialogCallback

        ''' <summary>
        ''' Creates a new auth manager.
        ''' </summary>
        ''' <param name="context">Shared context to populate with auth state.</param>
        ''' <param name="tokenStore">Token store for persisting auth data.</param>
        ''' <param name="signInCallback">Callback to open the sign-in dialog (provided by host).</param>
        Public Sub New(context As ISharedContext, tokenStore As ClerkTokenStore, signInCallback As SignInDialogCallback)
            _context = context
            _tokenStore = tokenStore
            _signInCallback = signInCallback
        End Sub

        ''' <summary>
        ''' Initializes authentication state from cached token.
        ''' Call this during add-in startup after config is loaded.
        ''' Non-blocking — if no cached token or token expired, the user remains unauthenticated.
        ''' </summary>
        Public Async Function InitializeAsync() As Task
            ' Ensure API client is created if Clerk is configured
            If Not EnsureApiClient() Then
                ClearContextAuth()
                Return
            End If

            ' Check for stored token
            If Not _tokenStore.HasValidToken() Then
                _tokenStore.ClearToken()
                ClearContextAuth()
                Return
            End If

            ' Load and populate from cache
            Dim stored = _tokenStore.LoadToken()
            If stored Is Nothing OrElse stored.IsExpired Then
                _tokenStore.ClearToken()
                ClearContextAuth()
                Return
            End If

            ' Populate context from cached data (skip API verification for fast startup)
            PopulateContext(stored.SessionToken, stored.UserId, stored.UserEmail, stored.UserName, stored.TokenExpiry)

            ' Optionally verify in background (non-blocking)
            Try
                Dim sessionInfo = Await _apiClient.VerifySessionAsync(stored.SessionId, stored.SessionToken).ConfigureAwait(False)
                If sessionInfo Is Nothing Then
                    ' Token no longer valid on server side
                    _tokenStore.ClearToken()
                    ClearContextAuth()
                End If
            Catch
                ' Network error during background verify — keep cached state
            End Try
        End Function

        ''' <summary>
        ''' Triggers the sign-in flow. Opens the sign-in dialog, verifies the result,
        ''' stores the token, and updates the shared context.
        ''' </summary>
        ''' <returns>True if sign-in succeeded, False if cancelled or failed.</returns>
        Public Async Function SignInAsync() As Task(Of Boolean)
            If Not EnsureApiClient() Then
                Return False
            End If

            ' Invoke the sign-in dialog callback (runs on UI thread)
            Dim result As ClerkSignInResult = Nothing
            Try
                result = _signInCallback(_context.INI_ClerkPublishableKey, _context.INI_ClerkDomain)
            Catch
                Return False
            End Try

            If result Is Nothing OrElse String.IsNullOrWhiteSpace(result.SessionToken) Then
                Return False
            End If

            ' Fetch user info from Clerk Backend API
            Dim userInfo As ClerkUserInfo = Nothing
            If Not String.IsNullOrWhiteSpace(result.UserId) Then
                Try
                    userInfo = Await _apiClient.GetUserAsync(result.UserId).ConfigureAwait(False)
                Catch
                    ' Continue without user info — we have the basics from the sign-in result
                End Try
            End If

            Dim email = If(userInfo?.Email, result.UserEmail)
            Dim displayName = If(userInfo?.DisplayName, result.UserName)
            Dim userId = If(result.UserId, userInfo?.UserId)
            Dim expiry = result.TokenExpiry

            ' Store token securely
            _tokenStore.SaveToken(result.SessionToken, result.SessionId, userId, email, displayName, expiry)

            ' Update shared context
            PopulateContext(result.SessionToken, userId, email, displayName, expiry)

            Return True
        End Function

        ''' <summary>
        ''' Signs out the current user. Clears stored tokens and resets context.
        ''' </summary>
        Public Sub SignOut()
            _tokenStore.ClearToken()
            ClearContextAuth()
        End Sub

        ''' <summary>
        ''' Returns whether the user is currently authenticated.
        ''' </summary>
        Public ReadOnly Property IsAuthenticated As Boolean
            Get
                Return _context.Auth_IsAuthenticated
            End Get
        End Property

        ''' <summary>
        ''' Returns the current user's display name, or empty string if not authenticated.
        ''' </summary>
        Public ReadOnly Property CurrentUserName As String
            Get
                If _context.Auth_IsAuthenticated Then
                    If Not String.IsNullOrWhiteSpace(_context.Auth_UserName) Then Return _context.Auth_UserName
                    If Not String.IsNullOrWhiteSpace(_context.Auth_UserEmail) Then Return _context.Auth_UserEmail
                End If
                Return ""
            End Get
        End Property

        ''' <summary>
        ''' Ensures the API client is created. Returns False if Clerk is not configured.
        ''' </summary>
        Private Function EnsureApiClient() As Boolean
            If _apiClient IsNot Nothing Then Return True
            If String.IsNullOrWhiteSpace(_context.INI_ClerkSecretKey) Then Return False
            _apiClient = New ClerkApiClient(_context.INI_ClerkSecretKey)
            Return True
        End Function

        ''' <summary>
        ''' Populates the shared context with auth state.
        ''' </summary>
        Private Sub PopulateContext(sessionToken As String, userId As String, email As String, displayName As String, tokenExpiry As Long)
            _context.Auth_IsAuthenticated = True
            _context.Auth_SessionToken = sessionToken
            _context.Auth_UserId = If(userId, "")
            _context.Auth_UserEmail = If(email, "")
            _context.Auth_UserName = If(displayName, "")
            _context.Auth_TokenExpiry = tokenExpiry
        End Sub

        ''' <summary>
        ''' Resets all auth-related properties on the shared context.
        ''' </summary>
        Private Sub ClearContextAuth()
            _context.Auth_IsAuthenticated = False
            _context.Auth_SessionToken = ""
            _context.Auth_UserId = ""
            _context.Auth_UserEmail = ""
            _context.Auth_UserName = ""
            _context.Auth_TokenExpiry = 0
        End Sub

    End Class

    ''' <summary>
    ''' Result returned by the sign-in dialog after successful Clerk authentication.
    ''' </summary>
    Public Class ClerkSignInResult
        Public Property SessionToken As String
        Public Property SessionId As String
        Public Property UserId As String
        Public Property UserEmail As String
        Public Property UserName As String
        Public Property TokenExpiry As Long
    End Class

End Namespace
