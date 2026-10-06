#!/bin/bash
# Quick start script for testing faucet in regtest mode

set -e

echo "=== Bitcoin Quantum Faucet - Regtest Setup ==="
echo ""

# Check if btqd is running
if ! btq-cli -regtest getblockchaininfo &>/dev/null; then
    echo "Error: btqd not running in regtest mode"
    echo "Start it with: btqd -regtest -daemon -rpcuser=test -rpcpassword=test"
    exit 1
fi

echo "✓ btqd is running"

# Check if wallet exists
if ! btq-cli -regtest -rpcwallet=faucet getwalletinfo &>/dev/null; then
    echo "Creating faucet wallet..."
    btq-cli -regtest createwallet faucet
    echo "✓ Wallet created"
else
    echo "✓ Wallet exists"
fi

# Check balance
BALANCE=$(btq-cli -regtest -rpcwallet=faucet getbalance)
echo "Current balance: $BALANCE BTQ"

if (( $(echo "$BALANCE < 1" | bc -l) )); then
    echo "Generating blocks to fund wallet..."
    ADDR=$(btq-cli -regtest -rpcwallet=faucet getnewdilithiumaddress)
    btq-cli -regtest -rpcwallet=faucet generatetoaddress 101 "$ADDR" > /dev/null
    BALANCE=$(btq-cli -regtest -rpcwallet=faucet getbalance)
    echo "✓ Generated blocks, new balance: $BALANCE BTQ"
fi

# Check if wallet is encrypted
WALLET_INFO=$(btq-cli -regtest -rpcwallet=faucet getwalletinfo)
if echo "$WALLET_INFO" | grep -q "unlocked_until"; then
    echo "⚠ Wallet is encrypted - make sure it's unlocked!"
    echo "  Unlock with: btq-cli -regtest -rpcwallet=faucet walletpassphrase <passphrase> 0"
fi

echo ""
echo "=== Starting Faucet Server ==="
echo ""

cd "$(dirname "$0")/server"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Start server with regtest configuration
export RPC_PORT=18443
export BECH32_HRP=qcrt
export RPC_USER=test
export RPC_PASS=test
export DIFFICULTY_BASE=3
export DIFFICULTY_STEP_SECONDS=600
export REWARD_PER_MINUTE=0.05
export MIN_CLAIM=0.01

echo "Starting server on http://localhost:3000"
echo "Press Ctrl+C to stop"
echo ""

npm start
