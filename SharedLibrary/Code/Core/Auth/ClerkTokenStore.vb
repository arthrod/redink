' Part of "Red Ink" (SharedLibrary)
' Copyright (c) LawDigital Ltd., Switzerland. All rights reserved. For license to use see https://redink.ai.
'
' =============================================================================
' File: ClerkTokenStore.vb
' Purpose: Securely persists and retrieves Clerk session tokens using DPAPI
'          (Data Protection API) encryption scoped to the current Windows user.
'
' Architecture:
'  - Encrypts session tokens with ProtectedData (DPAPI, CurrentUser scope) before
'    storing them, ensuring different Windows users on shared machines cannot read
'    each other's tokens.
'  - Non-sensitive metadata (user ID, email, display name, expiry) is stored in
'    plain text via the settings callback so it can be displayed in the UI without
'    decryption.
'  - The caller provides save/load/clear callbacks that map to the host project's
'    My.Settings persistence mechanism, keeping this class decoupled from any
'    specific project.
' =============================================================================

Option Strict On
Option Explicit On

Imports System.Security.Cryptography

Namespace SharedLibrary

    ''' <summary>
    ''' Manages secure storage and retrieval of Clerk auth tokens using DPAPI encryption.
    ''' </summary>
    Public Class ClerkTokenStore

        ''' <summary>
        ''' Holds all persisted auth data (token + metadata).
        ''' </summary>
        Public Class StoredAuthData
            Public Property EncryptedToken As String       ' Base64-encoded DPAPI-encrypted token
            Public Property UserId As String
            Public Property UserEmail As String
            Public Property UserName As String
            Public Property SessionId As String
            Public Property TokenExpiry As Long             ' Unix timestamp (seconds)
        End Class

        ' Callbacks for My.Settings persistence (set by host project)
        Private ReadOnly _saveAction As Action(Of StoredAuthData)
        Private ReadOnly _loadFunc As Func(Of StoredAuthData)
        Private ReadOnly _clearAction As Action

        ''' <summary>
        ''' Creates a token store with callbacks for persisting data via My.Settings.
        ''' </summary>
        ''' <param name="saveAction">Saves auth data to My.Settings.</param>
        ''' <param name="loadFunc">Loads auth data from My.Settings.</param>
        ''' <param name="clearAction">Clears auth data from My.Settings.</param>
        Public Sub New(saveAction As Action(Of StoredAuthData), loadFunc As Func(Of StoredAuthData), clearAction As Action)
            _saveAction = saveAction
            _loadFunc = loadFunc
            _clearAction = clearAction
        End Sub

        ''' <summary>
        ''' Encrypts and stores a session token along with user metadata.
        ''' </summary>
        ''' <param name="sessionToken">The Clerk session JWT token.</param>
        ''' <param name="sessionId">The Clerk session ID.</param>
        ''' <param name="userId">The Clerk user ID.</param>
        ''' <param name="userEmail">User's email address.</param>
        ''' <param name="userName">User's display name.</param>
        ''' <param name="tokenExpiry">Token expiry as Unix timestamp (seconds).</param>
        Public Sub SaveToken(sessionToken As String, sessionId As String, userId As String,
                             userEmail As String, userName As String, tokenExpiry As Long)
            Dim encryptedToken = EncryptToken(sessionToken)

            Dim data As New StoredAuthData() With {
                .EncryptedToken = encryptedToken,
                .UserId = userId,
                .UserEmail = userEmail,
                .UserName = userName,
                .SessionId = sessionId,
                .TokenExpiry = tokenExpiry
            }

            _saveAction(data)
        End Sub

        ''' <summary>
        ''' Loads stored auth data, decrypts the session token, and returns it.
        ''' Returns Nothing if no valid data is stored or decryption fails.
        ''' </summary>
        Public Function LoadToken() As ClerkStoredSession
            Try
                Dim data = _loadFunc()
                If data Is Nothing OrElse String.IsNullOrWhiteSpace(data.EncryptedToken) Then
                    Return Nothing
                End If

                Dim token = DecryptToken(data.EncryptedToken)
                If String.IsNullOrWhiteSpace(token) Then Return Nothing

                Return New ClerkStoredSession() With {
                    .SessionToken = token,
                    .SessionId = data.SessionId,
                    .UserId = data.UserId,
                    .UserEmail = data.UserEmail,
                    .UserName = data.UserName,
                    .TokenExpiry = data.TokenExpiry
                }
            Catch
                Return Nothing
            End Try
        End Function

        ''' <summary>
        ''' Clears all stored auth data.
        ''' </summary>
        Public Sub ClearToken()
            _clearAction()
        End Sub

        ''' <summary>
        ''' Checks whether a stored token exists and has not expired.
        ''' Does not decrypt the token (fast check).
        ''' </summary>
        Public Function HasValidToken() As Boolean
            Try
                Dim data = _loadFunc()
                If data Is Nothing OrElse String.IsNullOrWhiteSpace(data.EncryptedToken) Then Return False
                If data.TokenExpiry <= 0 Then Return False

                Dim nowUnix = CLng((DateTime.UtcNow - New DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds)
                Return data.TokenExpiry > nowUnix
            Catch
                Return False
            End Try
        End Function

        ''' <summary>
        ''' Encrypts a token string using DPAPI (CurrentUser scope).
        ''' Returns a Base64-encoded string of the encrypted bytes.
        ''' </summary>
        Friend Shared Function EncryptToken(token As String) As String
            If String.IsNullOrEmpty(token) Then Return ""
            Dim plainBytes = System.Text.Encoding.UTF8.GetBytes(token)
            Dim encryptedBytes = ProtectedData.Protect(plainBytes, Nothing, DataProtectionScope.CurrentUser)
            Return Convert.ToBase64String(encryptedBytes)
        End Function

        ''' <summary>
        ''' Decrypts a Base64-encoded DPAPI-encrypted token string.
        ''' Returns the original token, or empty string on failure.
        ''' </summary>
        Friend Shared Function DecryptToken(encryptedBase64 As String) As String
            If String.IsNullOrEmpty(encryptedBase64) Then Return ""
            Try
                Dim encryptedBytes = Convert.FromBase64String(encryptedBase64)
                Dim plainBytes = ProtectedData.Unprotect(encryptedBytes, Nothing, DataProtectionScope.CurrentUser)
                Return System.Text.Encoding.UTF8.GetString(plainBytes)
            Catch
                Return ""
            End Try
        End Function

    End Class

    ''' <summary>
    ''' Represents a decrypted, loaded Clerk session with all metadata.
    ''' </summary>
    Public Class ClerkStoredSession
        Public Property SessionToken As String
        Public Property SessionId As String
        Public Property UserId As String
        Public Property UserEmail As String
        Public Property UserName As String
        Public Property TokenExpiry As Long

        ''' <summary>
        ''' Checks whether this session token has expired.
        ''' </summary>
        Public ReadOnly Property IsExpired As Boolean
            Get
                If TokenExpiry <= 0 Then Return True
                Dim nowUnix = CLng((DateTime.UtcNow - New DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds)
                Return TokenExpiry <= nowUnix
            End Get
        End Property
    End Class

End Namespace
