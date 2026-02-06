' Part of "Red Ink" (SharedLibrary)
' Copyright (c) LawDigital Ltd., Switzerland. All rights reserved. For license to use see https://redink.ai.
'
' =============================================================================
' File: ClerkApiClient.vb
' Purpose: Provides a REST client for verifying Clerk session tokens and retrieving
'          user information from the Clerk Backend API.
'
' Architecture:
'  - Uses HttpClient to call Clerk Backend API endpoints.
'  - Authenticates requests using the Clerk Secret Key (Bearer token).
'  - Provides methods to verify session JWTs and retrieve user details.
'  - Returns structured result objects for the calling code to act upon.
'
' Clerk Backend API reference:
'  - Base URL: https://api.clerk.com/v1/
'  - Authentication: Bearer <secret_key>
'  - Verify session: GET /v1/sessions/{session_id}/verify
'  - Get user: GET /v1/users/{user_id}
' =============================================================================

Option Strict On
Option Explicit On

Imports System.Net.Http
Imports System.Net.Http.Headers
Imports System.Text
Imports System.Threading.Tasks
Imports Newtonsoft.Json.Linq

Namespace SharedLibrary

    ''' <summary>
    ''' REST client for Clerk Backend API operations (session verification, user retrieval).
    ''' </summary>
    Public Class ClerkApiClient

        Private Const ClerkApiBaseUrl As String = "https://api.clerk.com/v1/"
        Private Const ApiTimeoutMs As Integer = 10000
        Private Const ApiRetryCount As Integer = 3

        Private ReadOnly _secretKey As String
        Private ReadOnly _httpClient As HttpClient

        ''' <summary>
        ''' Creates a new Clerk API client with the given secret key.
        ''' </summary>
        ''' <param name="secretKey">Clerk Secret Key (sk_test_... or sk_live_...).</param>
        Public Sub New(secretKey As String)
            _secretKey = secretKey
            _httpClient = New HttpClient()
            _httpClient.Timeout = TimeSpan.FromMilliseconds(ApiTimeoutMs)
            _httpClient.DefaultRequestHeaders.Authorization = New AuthenticationHeaderValue("Bearer", secretKey)
            _httpClient.DefaultRequestHeaders.Accept.Add(New MediaTypeWithQualityHeaderValue("application/json"))
        End Sub

        ''' <summary>
        ''' Creates a new Clerk API client with the given secret key and an externally provided HttpClient (for testing).
        ''' </summary>
        Public Sub New(secretKey As String, httpClient As HttpClient)
            _secretKey = secretKey
            _httpClient = httpClient
            If _httpClient.DefaultRequestHeaders.Authorization Is Nothing Then
                _httpClient.DefaultRequestHeaders.Authorization = New AuthenticationHeaderValue("Bearer", secretKey)
            End If
        End Sub

        ''' <summary>
        ''' Verifies a Clerk session token by calling the Backend API.
        ''' Returns a <see cref="ClerkSessionInfo"/> on success, or Nothing on failure.
        ''' </summary>
        ''' <param name="sessionId">The Clerk session ID to verify.</param>
        ''' <param name="sessionToken">The JWT session token.</param>
        ''' <returns>Session info if valid, or Nothing if invalid/expired/error.</returns>
        Public Async Function VerifySessionAsync(sessionId As String, sessionToken As String) As Task(Of ClerkSessionInfo)
            If String.IsNullOrWhiteSpace(sessionId) OrElse String.IsNullOrWhiteSpace(sessionToken) Then
                Return Nothing
            End If

            Dim lastError As String = ""
            For attempt = 1 To ApiRetryCount
                Try
                    Dim url = $"{ClerkApiBaseUrl}sessions/{sessionId}/verify"
                    Dim content = New StringContent($"{{""token"":""{EscapeJsonString(sessionToken)}""}}", Encoding.UTF8, "application/json")
                    Dim response = Await _httpClient.PostAsync(url, content).ConfigureAwait(False)

                    If response.IsSuccessStatusCode Then
                        Dim json = Await response.Content.ReadAsStringAsync().ConfigureAwait(False)
                        Return ParseSessionInfo(json)
                    ElseIf response.StatusCode = Net.HttpStatusCode.Unauthorized OrElse
                           response.StatusCode = Net.HttpStatusCode.NotFound OrElse
                           response.StatusCode = Net.HttpStatusCode.Gone Then
                        ' Session invalid, expired, or not found — no retry
                        Return Nothing
                    ElseIf CInt(response.StatusCode) = 429 Then
                        ' Rate limited — retry with backoff
                        lastError = "Rate limited"
                        Await Task.Delay(CInt(Math.Pow(2, attempt)) * 1000).ConfigureAwait(False)
                    Else
                        lastError = $"HTTP {CInt(response.StatusCode)}"
                    End If
                Catch ex As TaskCanceledException
                    lastError = "Timeout"
                Catch ex As HttpRequestException
                    lastError = ex.Message
                    If attempt < ApiRetryCount Then
                        Await Task.Delay(CInt(Math.Pow(2, attempt)) * 1000).ConfigureAwait(False)
                    End If
                End Try
            Next

            Return Nothing
        End Function

        ''' <summary>
        ''' Retrieves user information from Clerk Backend API.
        ''' </summary>
        ''' <param name="userId">The Clerk user ID (user_...).</param>
        ''' <returns>User info if found, or Nothing on error.</returns>
        Public Async Function GetUserAsync(userId As String) As Task(Of ClerkUserInfo)
            If String.IsNullOrWhiteSpace(userId) Then Return Nothing

            For attempt = 1 To ApiRetryCount
                Try
                    Dim url = $"{ClerkApiBaseUrl}users/{userId}"
                    Dim response = Await _httpClient.GetAsync(url).ConfigureAwait(False)

                    If response.IsSuccessStatusCode Then
                        Dim json = Await response.Content.ReadAsStringAsync().ConfigureAwait(False)
                        Return ParseUserInfo(json)
                    ElseIf response.StatusCode = Net.HttpStatusCode.NotFound Then
                        Return Nothing
                    ElseIf CInt(response.StatusCode) = 429 Then
                        Await Task.Delay(CInt(Math.Pow(2, attempt)) * 1000).ConfigureAwait(False)
                    End If
                Catch ex As TaskCanceledException
                    ' Timeout
                Catch ex As HttpRequestException
                    If attempt < ApiRetryCount Then
                        Await Task.Delay(CInt(Math.Pow(2, attempt)) * 1000).ConfigureAwait(False)
                    End If
                End Try
            Next

            Return Nothing
        End Function

        ''' <summary>
        ''' Parses session verification response JSON into a <see cref="ClerkSessionInfo"/>.
        ''' </summary>
        Private Shared Function ParseSessionInfo(json As String) As ClerkSessionInfo
            Try
                Dim obj = JObject.Parse(json)
                Dim status = obj.Value(Of String)("status")
                If status <> "active" Then Return Nothing

                Return New ClerkSessionInfo() With {
                    .SessionId = obj.Value(Of String)("id"),
                    .UserId = obj.Value(Of String)("user_id"),
                    .Status = status,
                    .ExpireAt = obj.Value(Of Long)("expire_at"),
                    .LastActiveAt = obj.Value(Of Long)("last_active_at")
                }
            Catch
                Return Nothing
            End Try
        End Function

        ''' <summary>
        ''' Parses user retrieval response JSON into a <see cref="ClerkUserInfo"/>.
        ''' </summary>
        Private Shared Function ParseUserInfo(json As String) As ClerkUserInfo
            Try
                Dim obj = JObject.Parse(json)
                Dim emails = obj("email_addresses")
                Dim primaryEmail = ""
                Dim primaryEmailId = obj.Value(Of String)("primary_email_address_id")

                If emails IsNot Nothing AndAlso primaryEmailId IsNot Nothing Then
                    For Each email In emails
                        If email.Value(Of String)("id") = primaryEmailId Then
                            primaryEmail = email.Value(Of String)("email_address")
                            Exit For
                        End If
                    Next
                End If

                Return New ClerkUserInfo() With {
                    .UserId = obj.Value(Of String)("id"),
                    .FirstName = If(obj.Value(Of String)("first_name"), ""),
                    .LastName = If(obj.Value(Of String)("last_name"), ""),
                    .Email = primaryEmail,
                    .CreatedAt = obj.Value(Of Long)("created_at"),
                    .UpdatedAt = obj.Value(Of Long)("updated_at")
                }
            Catch
                Return Nothing
            End Try
        End Function

        ''' <summary>
        ''' Escapes a string for safe JSON embedding.
        ''' </summary>
        Private Shared Function EscapeJsonString(value As String) As String
            If String.IsNullOrEmpty(value) Then Return ""
            Return value.Replace("\", "\\").Replace("""", "\""").Replace(vbCr, "\r").Replace(vbLf, "\n").Replace(vbTab, "\t")
        End Function

    End Class

    ''' <summary>
    ''' Represents a verified Clerk session.
    ''' </summary>
    Public Class ClerkSessionInfo
        Public Property SessionId As String
        Public Property UserId As String
        Public Property Status As String
        Public Property ExpireAt As Long
        Public Property LastActiveAt As Long
    End Class

    ''' <summary>
    ''' Represents a Clerk user's profile information.
    ''' </summary>
    Public Class ClerkUserInfo
        Public Property UserId As String
        Public Property FirstName As String
        Public Property LastName As String
        Public Property Email As String
        Public Property CreatedAt As Long
        Public Property UpdatedAt As Long

        ''' <summary>
        ''' Returns the user's display name (first + last, or email if no name).
        ''' </summary>
        Public ReadOnly Property DisplayName As String
            Get
                Dim name = $"{FirstName} {LastName}".Trim()
                If String.IsNullOrEmpty(name) Then Return Email
                Return name
            End Get
        End Property
    End Class

End Namespace
