#!/usr/bin/env bash
# SaaS API Test Script
# Usage: ./test-api.sh

set -e

BASE_URL="${API_URL:-http://localhost:3000}"
EMAIL="test-$(date +%s)@example.com"
PASSWORD="SecurePass123"

echo "=== Moltbot SaaS API Tests ==="
echo "Base URL: $BASE_URL"
echo "Test email: $EMAIL"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

pass() { echo -e "${GREEN}✓ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }

# 1. Health check
echo "1. Testing health endpoint..."
HEALTH=$(curl -s "$BASE_URL/health")
echo "$HEALTH" | grep -q '"status":"ok"' && pass "Health check" || fail "Health check failed"

# 2. Signup
echo ""
echo "2. Testing signup..."
SIGNUP_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$EMAIL\", \"password\": \"$PASSWORD\"}")
echo "$SIGNUP_RESPONSE" | jq -r '.user.id' > /dev/null 2>&1 && pass "Signup" || fail "Signup failed: $SIGNUP_RESPONSE"

# 3. Login
echo ""
echo "3. Testing login..."
LOGIN_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$EMAIL\", \"password\": \"$PASSWORD\"}")

ACCESS_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.tokens.accessToken')
REFRESH_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.tokens.refreshToken')

if [ "$ACCESS_TOKEN" != "null" ] && [ -n "$ACCESS_TOKEN" ]; then
  pass "Login - got access token"
else
  fail "Login failed: $LOGIN_RESPONSE"
fi

# 4. Get current user
echo ""
echo "4. Testing /api/auth/me..."
ME_RESPONSE=$(curl -s "$BASE_URL/api/auth/me" \
  -H "Authorization: Bearer $ACCESS_TOKEN")
echo "$ME_RESPONSE" | jq -r '.email' | grep -q "$EMAIL" && pass "Get current user" || fail "Get user failed: $ME_RESPONSE"

# 5. Refresh token
echo ""
echo "5. Testing token refresh..."
REFRESH_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/refresh" \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\": \"$REFRESH_TOKEN\"}")
NEW_ACCESS=$(echo "$REFRESH_RESPONSE" | jq -r '.tokens.accessToken')
[ "$NEW_ACCESS" != "null" ] && [ -n "$NEW_ACCESS" ] && pass "Token refresh" || fail "Refresh failed: $REFRESH_RESPONSE"

# 6. Agent status (should show not provisioned)
echo ""
echo "6. Testing /api/agent/status..."
AGENT_RESPONSE=$(curl -s "$BASE_URL/api/agent/status" \
  -H "Authorization: Bearer $ACCESS_TOKEN")
echo "$AGENT_RESPONSE" | jq -r '.status' | grep -qE '(not_provisioned|provisioning|active)' && pass "Agent status" || fail "Agent status failed: $AGENT_RESPONSE"

# 7. Usage endpoint
echo ""
echo "7. Testing /api/usage..."
USAGE_RESPONSE=$(curl -s "$BASE_URL/api/usage" \
  -H "Authorization: Bearer $ACCESS_TOKEN")
echo "$USAGE_RESPONSE" | jq -r '.tier' | grep -q "free" && pass "Usage endpoint" || fail "Usage failed: $USAGE_RESPONSE"

# 8. Billing plans
echo ""
echo "8. Testing /api/billing/plans..."
PLANS_RESPONSE=$(curl -s "$BASE_URL/api/billing/plans" \
  -H "Authorization: Bearer $ACCESS_TOKEN")
echo "$PLANS_RESPONSE" | jq -r '.plans[0].tier' > /dev/null 2>&1 && pass "Billing plans" || fail "Plans failed: $PLANS_RESPONSE"

# 9. Test invalid token
echo ""
echo "9. Testing auth rejection with invalid token..."
INVALID_RESPONSE=$(curl -s "$BASE_URL/api/auth/me" \
  -H "Authorization: Bearer invalid-token")
echo "$INVALID_RESPONSE" | grep -q "Invalid" && pass "Invalid token rejected" || fail "Should reject invalid token: $INVALID_RESPONSE"

# 10. Logout
echo ""
echo "10. Testing logout..."
LOGOUT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/logout" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}')
echo "$LOGOUT_RESPONSE" | grep -qi "success\|logged" && pass "Logout" || fail "Logout failed: $LOGOUT_RESPONSE"

echo ""
echo "=== All tests passed! ==="
