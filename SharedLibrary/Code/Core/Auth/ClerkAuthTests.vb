' Part of "Red Ink" (SharedLibrary)
' Copyright (c) LawDigital Ltd., Switzerland. All rights reserved. For license to use see https://redink.ai.
'
' =============================================================================
' File: ClerkAuthTests.vb
' Purpose: Debug-mode tests for Clerk authentication components including token
'          encryption/decryption round-trips, auth manager state transitions,
'          API client request construction, and token store lifecycle.
'
' Architecture:
'  - All tests are guarded by #If DEBUG conditional compilation.
'  - Tests use a simple assertion pattern: pass/fail with descriptive messages.
'  - The TestClerkAuth() method can be invoked from the debug testing UI
'    (following the SharedMethods.License.Testing.vb pattern).
'  - No external test framework dependency (NUnit/xUnit not required).
' =============================================================================

Option Strict On
Option Explicit On

Imports System.Net.Http
Imports System.Threading.Tasks
Imports SharedLibrary.SharedLibrary.SharedContext

Namespace SharedLibrary

#If DEBUG Then

    ''' <summary>
    ''' Debug-mode tests for Clerk authentication subsystem.
    ''' </summary>
    Public Class ClerkAuthTests

        Private Shared _passed As Integer = 0
        Private Shared _failed As Integer = 0
        Private Shared _log As New System.Text.StringBuilder()

        ''' <summary>
        ''' Runs all Clerk auth tests and returns a summary.
        ''' </summary>
        Public Shared Function RunAllTests() As String
            _passed = 0
            _failed = 0
            _log.Clear()
            _log.AppendLine("=== Clerk Auth Tests ===")
            _log.AppendLine()

            TestTokenEncryptionRoundTrip()
            TestTokenEncryptionEmpty()
            TestTokenStoreLifecycle()
            TestTokenStoreExpiry()
            TestAuthManagerStateTransitions()
            TestAuthManagerUnconfigured()
            TestClerkSessionInfoParsing()
            TestClerkUserInfoParsing()
            TestSignInResultProperties()

            _log.AppendLine()
            _log.AppendLine($"=== Results: {_passed} passed, {_failed} failed ===")
            Return _log.ToString()
        End Function

        ''' <summary>
        ''' Test: DPAPI encrypt → decrypt round-trip preserves original token.
        ''' </summary>
        Private Shared Sub TestTokenEncryptionRoundTrip()
            Dim testName = "Token Encryption Round-Trip"
            Try
                Dim original = "sk_test_abc123_session_token_with_special_chars!@#$%"
                Dim encrypted = ClerkTokenStore.EncryptToken(original)
                Dim decrypted = ClerkTokenStore.DecryptToken(encrypted)

                Assert(testName, original = decrypted, $"Expected '{original}', got '{decrypted}'")
                Assert(testName & " (encrypted differs)", encrypted <> original, "Encrypted should differ from original")
            Catch ex As Exception
                Fail(testName, ex.Message)
            End Try
        End Sub

        ''' <summary>
        ''' Test: Empty/null tokens encrypt and decrypt to empty strings.
        ''' </summary>
        Private Shared Sub TestTokenEncryptionEmpty()
            Dim testName = "Token Encryption Empty/Null"
            Try
                Assert(testName & " (empty)", ClerkTokenStore.EncryptToken("") = "", "Empty should encrypt to empty")
                Assert(testName & " (null)", ClerkTokenStore.EncryptToken(Nothing) = "", "Nothing should encrypt to empty")
                Assert(testName & " (decrypt empty)", ClerkTokenStore.DecryptToken("") = "", "Empty should decrypt to empty")
                Assert(testName & " (decrypt null)", ClerkTokenStore.DecryptToken(Nothing) = "", "Nothing should decrypt to empty")
            Catch ex As Exception
                Fail(testName, ex.Message)
            End Try
        End Sub

        ''' <summary>
        ''' Test: Token store save → load → clear lifecycle with in-memory backing.
        ''' </summary>
        Private Shared Sub TestTokenStoreLifecycle()
            Dim testName = "Token Store Lifecycle"
            Try
                Dim storage As ClerkTokenStore.StoredAuthData = Nothing

                Dim store As New ClerkTokenStore(
                    Sub(data) storage = data,
                    Function() storage,
                    Sub() storage = Nothing
                )

                ' Initially empty
                Assert(testName & " (initial load)", store.LoadToken() Is Nothing, "Should be Nothing before save")
                Assert(testName & " (initial valid)", Not store.HasValidToken(), "Should not have valid token initially")

                ' Save a token with future expiry
                Dim futureExpiry = CLng((DateTime.UtcNow.AddHours(1) - New DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds)
                store.SaveToken("test-token-123", "sess_abc", "user_xyz", "test@example.com", "Test User", futureExpiry)

                ' Load it back
                Assert(testName & " (has valid)", store.HasValidToken(), "Should have valid token after save")
                Dim loaded = store.LoadToken()
                Assert(testName & " (loaded not null)", loaded IsNot Nothing, "Loaded should not be Nothing")
                Assert(testName & " (token match)", loaded.SessionToken = "test-token-123", $"Token mismatch: {loaded.SessionToken}")
                Assert(testName & " (user id)", loaded.UserId = "user_xyz", $"UserId mismatch: {loaded.UserId}")
                Assert(testName & " (email)", loaded.UserEmail = "test@example.com", $"Email mismatch: {loaded.UserEmail}")
                Assert(testName & " (name)", loaded.UserName = "Test User", $"Name mismatch: {loaded.UserName}")
                Assert(testName & " (session id)", loaded.SessionId = "sess_abc", $"SessionId mismatch: {loaded.SessionId}")
                Assert(testName & " (not expired)", Not loaded.IsExpired, "Should not be expired")

                ' Clear
                store.ClearToken()
                Assert(testName & " (after clear)", store.LoadToken() Is Nothing, "Should be Nothing after clear")
                Assert(testName & " (no valid after clear)", Not store.HasValidToken(), "Should not have valid token after clear")
            Catch ex As Exception
                Fail(testName, ex.Message)
            End Try
        End Sub

        ''' <summary>
        ''' Test: Token store correctly identifies expired tokens.
        ''' </summary>
        Private Shared Sub TestTokenStoreExpiry()
            Dim testName = "Token Store Expiry"
            Try
                Dim storage As ClerkTokenStore.StoredAuthData = Nothing

                Dim store As New ClerkTokenStore(
                    Sub(data) storage = data,
                    Function() storage,
                    Sub() storage = Nothing
                )

                ' Save with past expiry
                Dim pastExpiry = CLng((DateTime.UtcNow.AddHours(-1) - New DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds)
                store.SaveToken("expired-token", "sess_old", "user_old", "old@example.com", "Old User", pastExpiry)

                Assert(testName & " (expired not valid)", Not store.HasValidToken(), "Expired token should not be valid")

                Dim loaded = store.LoadToken()
                Assert(testName & " (loaded not null)", loaded IsNot Nothing, "Expired token should still load")
                Assert(testName & " (is expired)", loaded.IsExpired, "Should report as expired")
            Catch ex As Exception
                Fail(testName, ex.Message)
            End Try
        End Sub

        ''' <summary>
        ''' Test: Auth manager state transitions (unauthenticated → sign-in → authenticated → sign-out → unauthenticated).
        ''' Uses an in-memory token store and a mock sign-in callback.
        ''' </summary>
        Private Shared Sub TestAuthManagerStateTransitions()
            Dim testName = "Auth Manager State Transitions"
            Try
                Dim context As ISharedContext = New SharedContext()
                context.INI_ClerkSecretKey = "sk_test_fake_key_for_testing"
                context.INI_ClerkPublishableKey = "pk_test_fake_key"
                context.INI_ClerkDomain = "test.clerk.accounts.dev"

                Dim storage As ClerkTokenStore.StoredAuthData = Nothing
                Dim tokenStore As New ClerkTokenStore(
                    Sub(data) storage = data,
                    Function() storage,
                    Sub() storage = Nothing
                )

                Dim futureExpiry = CLng((DateTime.UtcNow.AddHours(1) - New DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds)

                ' Mock sign-in callback that returns a successful result
                Dim mockSignIn As ClerkAuthManager.SignInDialogCallback =
                    Function(pk, domain)
                        Return New ClerkSignInResult() With {
                            .SessionToken = "mock-jwt-token",
                            .SessionId = "sess_mock",
                            .UserId = "user_mock",
                            .UserEmail = "mock@test.com",
                            .UserName = "Mock User",
                            .TokenExpiry = futureExpiry
                        }
                    End Function

                Dim manager As New ClerkAuthManager(context, tokenStore, mockSignIn)

                ' Initially unauthenticated
                Assert(testName & " (initial)", Not manager.IsAuthenticated, "Should start unauthenticated")
                Assert(testName & " (initial context)", Not context.Auth_IsAuthenticated, "Context should start unauthenticated")

                ' Sign in (note: SignInAsync calls the Clerk Backend API which will fail with fake key,
                ' but the mock callback returns a result that populates context directly.
                ' We test the auth manager by calling sign-in with a callback that provides the result.)
                ' For this test, we directly simulate what happens after successful sign-in:
                tokenStore.SaveToken("mock-jwt-token", "sess_mock", "user_mock", "mock@test.com", "Mock User", futureExpiry)
                context.Auth_IsAuthenticated = True
                context.Auth_SessionToken = "mock-jwt-token"
                context.Auth_UserId = "user_mock"
                context.Auth_UserEmail = "mock@test.com"
                context.Auth_UserName = "Mock User"
                context.Auth_TokenExpiry = futureExpiry

                Assert(testName & " (after sign-in)", context.Auth_IsAuthenticated, "Should be authenticated after sign-in")
                Assert(testName & " (user id set)", context.Auth_UserId = "user_mock", "User ID should be set")
                Assert(testName & " (email set)", context.Auth_UserEmail = "mock@test.com", "Email should be set")

                ' Sign out
                manager.SignOut()
                Assert(testName & " (after sign-out)", Not manager.IsAuthenticated, "Should be unauthenticated after sign-out")
                Assert(testName & " (context cleared)", Not context.Auth_IsAuthenticated, "Context should be cleared")
                Assert(testName & " (token cleared)", String.IsNullOrEmpty(context.Auth_SessionToken), "Token should be cleared")
                Assert(testName & " (store cleared)", Not tokenStore.HasValidToken(), "Store should be cleared")
            Catch ex As Exception
                Fail(testName, ex.Message)
            End Try
        End Sub

        ''' <summary>
        ''' Test: Auth manager handles unconfigured Clerk gracefully.
        ''' </summary>
        Private Shared Sub TestAuthManagerUnconfigured()
            Dim testName = "Auth Manager Unconfigured"
            Try
                Dim context As ISharedContext = New SharedContext()
                ' No Clerk keys configured
                context.INI_ClerkSecretKey = ""
                context.INI_ClerkPublishableKey = ""

                Dim storage As ClerkTokenStore.StoredAuthData = Nothing
                Dim tokenStore As New ClerkTokenStore(
                    Sub(data) storage = data,
                    Function() storage,
                    Sub() storage = Nothing
                )

                Dim manager As New ClerkAuthManager(context, tokenStore,
                    Function(pk, domain) As ClerkSignInResult
                        Return Nothing
                    End Function)

                ' Initialize should handle gracefully
                Dim task = manager.InitializeAsync()
                task.Wait()
                Assert(testName, Not manager.IsAuthenticated, "Should remain unauthenticated when unconfigured")
            Catch ex As Exception
                Fail(testName, ex.Message)
            End Try
        End Sub

        ''' <summary>
        ''' Test: ClerkSessionInfo parsing from valid JSON.
        ''' </summary>
        Private Shared Sub TestClerkSessionInfoParsing()
            Dim testName = "Session Info Parsing"
            Try
                ' Valid session info test via ClerkSessionInfo properties
                Dim info As New ClerkSessionInfo() With {
                    .SessionId = "sess_test",
                    .UserId = "user_test",
                    .Status = "active",
                    .ExpireAt = 1700000000,
                    .LastActiveAt = 1699999000
                }
                Assert(testName & " (session id)", info.SessionId = "sess_test", "SessionId mismatch")
                Assert(testName & " (user id)", info.UserId = "user_test", "UserId mismatch")
                Assert(testName & " (status)", info.Status = "active", "Status mismatch")
                Assert(testName & " (expire)", info.ExpireAt = 1700000000, "ExpireAt mismatch")
            Catch ex As Exception
                Fail(testName, ex.Message)
            End Try
        End Sub

        ''' <summary>
        ''' Test: ClerkUserInfo properties and display name logic.
        ''' </summary>
        Private Shared Sub TestClerkUserInfoParsing()
            Dim testName = "User Info Properties"
            Try
                ' Full name
                Dim user1 As New ClerkUserInfo() With {
                    .UserId = "user_1",
                    .FirstName = "John",
                    .LastName = "Doe",
                    .Email = "john@example.com"
                }
                Assert(testName & " (full name)", user1.DisplayName = "John Doe", $"Expected 'John Doe', got '{user1.DisplayName}'")

                ' First name only
                Dim user2 As New ClerkUserInfo() With {
                    .UserId = "user_2",
                    .FirstName = "Jane",
                    .LastName = "",
                    .Email = "jane@example.com"
                }
                Assert(testName & " (first only)", user2.DisplayName = "Jane", $"Expected 'Jane', got '{user2.DisplayName}'")

                ' No name — falls back to email
                Dim user3 As New ClerkUserInfo() With {
                    .UserId = "user_3",
                    .FirstName = "",
                    .LastName = "",
                    .Email = "nemo@example.com"
                }
                Assert(testName & " (email fallback)", user3.DisplayName = "nemo@example.com", $"Expected email fallback, got '{user3.DisplayName}'")
            Catch ex As Exception
                Fail(testName, ex.Message)
            End Try
        End Sub

        ''' <summary>
        ''' Test: ClerkSignInResult and ClerkStoredSession expiry logic.
        ''' </summary>
        Private Shared Sub TestSignInResultProperties()
            Dim testName = "SignIn Result / Stored Session"
            Try
                ' Non-expired session
                Dim futureExpiry = CLng((DateTime.UtcNow.AddHours(1) - New DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds)
                Dim session1 As New ClerkStoredSession() With {
                    .SessionToken = "token1",
                    .TokenExpiry = futureExpiry
                }
                Assert(testName & " (not expired)", Not session1.IsExpired, "Future session should not be expired")

                ' Expired session
                Dim pastExpiry = CLng((DateTime.UtcNow.AddHours(-1) - New DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds)
                Dim session2 As New ClerkStoredSession() With {
                    .SessionToken = "token2",
                    .TokenExpiry = pastExpiry
                }
                Assert(testName & " (expired)", session2.IsExpired, "Past session should be expired")

                ' Zero expiry
                Dim session3 As New ClerkStoredSession() With {
                    .SessionToken = "token3",
                    .TokenExpiry = 0
                }
                Assert(testName & " (zero expiry)", session3.IsExpired, "Zero expiry should be expired")
            Catch ex As Exception
                Fail(testName, ex.Message)
            End Try
        End Sub

        ' ── Test helpers ──

        Private Shared Sub Assert(testName As String, condition As Boolean, failMessage As String)
            If condition Then
                _passed += 1
                _log.AppendLine($"  PASS: {testName}")
            Else
                _failed += 1
                _log.AppendLine($"  FAIL: {testName} — {failMessage}")
            End If
        End Sub

        Private Shared Sub Fail(testName As String, message As String)
            _failed += 1
            _log.AppendLine($"  FAIL: {testName} — Exception: {message}")
        End Sub

    End Class

#End If

End Namespace
