#!/bin/bash

# Define the Key Vault name from first argument
KEYVAULT_NAME="${1?Error: Please provide Key Vault name as first argument}"

echo "Fetching secrets from Key Vault: $KEYVAULT_NAME"

# Get a list of all secret names in the Key Vault
secrets=$(az keyvault secret list --vault-name "$KEYVAULT_NAME" --query "[].name" -o tsv)

if [[ -z "$secrets" ]]; then
    echo "No secrets found in $KEYVAULT_NAME."
    exit 1
fi

# Loop through each secret and retrieve its value
for secret in $secrets; do
    value=$(az keyvault secret show --vault-name "$KEYVAULT_NAME" --name "$secret" --query "value" -o tsv)
    echo "Secret: $secret"
    echo "Value: $value"
done