import { getAccountNonce, getSenderAddress } from "permissionless"
import {
    SignTransactionNotSupportedBySmartAccount,
    type SmartAccount
} from "permissionless/accounts"
import {
    type Address,
    type Chain,
    type Client,
    type EncodeDeployDataParameters,
    type Hex,
    type Transport,
    type TypedDataDefinition,
    concatHex,
    decodeFunctionResult,
    encodeAbiParameters,
    encodeDeployData,
    encodeFunctionData,
    getTypesForEIP712Domain,
    hashTypedData,
    keccak256,
    parseAbi,
    stringToHex,
    validateTypedData
} from "viem"
import { toAccount } from "viem/accounts"
import { getBytecode, signMessage } from "viem/actions"
import type { KernelPlugin } from "../../types/kernel.js"
import { KernelExecuteAbi, KernelInitAbi } from "./abi/KernelAccountAbi.js"

export type CallType = "call" | "delegatecall"

type KernelEncodeCallDataArgs =
    | {
          to: Address
          value: bigint
          data: Hex
          callType: CallType | undefined
      }
    | {
          to: Address
          value: bigint
          data: Hex
          callType: CallType | undefined
      }[]

export type KernelSmartAccount<
    transport extends Transport = Transport,
    chain extends Chain | undefined = Chain | undefined
> = SmartAccount<"kernelSmartAccount", transport, chain> & {
    defaultValidator?: KernelPlugin<string, transport, chain>
    plugin?: KernelPlugin<string, transport, chain>
    getPluginEnableSignature: () => Promise<Hex | undefined>
    generateInitCode: () => Promise<Hex>
    encodeCallData: (args: KernelEncodeCallDataArgs) => Promise<Hex>
}

/**
 * The account creation ABI for a kernel smart account (from the KernelFactory)
 */
const createAccountAbi = [
    {
        inputs: [
            {
                internalType: "address",
                name: "_implementation",
                type: "address"
            },
            {
                internalType: "bytes",
                name: "_data",
                type: "bytes"
            },
            {
                internalType: "uint256",
                name: "_index",
                type: "uint256"
            }
        ],
        name: "createAccount",
        outputs: [
            {
                internalType: "address",
                name: "proxy",
                type: "address"
            }
        ],
        stateMutability: "payable",
        type: "function"
    }
] as const

// Safe's library for create and create2: https://github.com/safe-global/safe-contracts/blob/0acdd35a203299585438f53885df630f9d486a86/contracts/libraries/CreateCall.sol
// Address was found here: https://github.com/safe-global/safe-deployments/blob/926ec6bbe2ebcac3aa2c2c6c0aff74aa590cbc6a/src/assets/v1.4.1/create_call.json
const createCallAddress = "0x9b35Af71d77eaf8d7e40252370304687390A1A52"

const createCallAbi = parseAbi([
    "function performCreate(uint256 value, bytes memory deploymentData) public returns (address newContract)",
    "function performCreate2(uint256 value, bytes memory deploymentData, bytes32 salt) public returns (address newContract)"
])

const eip1271Abi = [
    {
        type: "function",
        name: "eip712Domain",
        inputs: [],
        outputs: [
            { name: "fields", type: "bytes1", internalType: "bytes1" },
            { name: "name", type: "string", internalType: "string" },
            { name: "version", type: "string", internalType: "string" },
            { name: "chainId", type: "uint256", internalType: "uint256" },
            {
                name: "verifyingContract",
                type: "address",
                internalType: "address"
            },
            { name: "salt", type: "bytes32", internalType: "bytes32" },
            { name: "extensions", type: "uint256[]", internalType: "uint256[]" }
        ],
        stateMutability: "view"
    },
    {
        type: "function",
        name: "isValidSignature",
        inputs: [
            { name: "data", type: "bytes32", internalType: "bytes32" },
            { name: "signature", type: "bytes", internalType: "bytes" }
        ],
        outputs: [
            { name: "magicValue", type: "bytes4", internalType: "bytes4" }
        ],
        stateMutability: "view"
    }
] as const
/**
 * Default addresses for kernel smart account
 */
export const KERNEL_ADDRESSES: {
    ACCOUNT_V2_3_LOGIC: Address
    FACTORY_ADDRESS: Address
    ENTRYPOINT_V0_6: Address
} = {
    ACCOUNT_V2_3_LOGIC: "0xD3F582F6B4814E989Ee8E96bc3175320B5A540ab",
    FACTORY_ADDRESS: "0x5de4839a76cf55d0c90e2061ef4386d962E15ae3",
    ENTRYPOINT_V0_6: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"
}

/**
 * Get the account initialization code for a kernel smart account
 * @param owner
 * @param index
 * @param factoryAddress
 * @param accountLogicAddress
 * @param ecdsaValidatorAddress
 */
const getAccountInitCode = async ({
    owner,
    index,
    factoryAddress,
    accountLogicAddress,
    validatorAddress,
    enableData
}: {
    owner: Address
    index: bigint
    factoryAddress: Address
    accountLogicAddress: Address
    validatorAddress: Address
    enableData: Promise<Hex>
}): Promise<Hex> => {
    if (!owner) throw new Error("Owner account not found")

    // Build the account initialization data
    const initialisationData = encodeFunctionData({
        abi: KernelInitAbi,
        functionName: "initialize",
        args: [validatorAddress, await enableData]
    })

    // Build the account init code
    return concatHex([
        factoryAddress,
        encodeFunctionData({
            abi: createAccountAbi,
            functionName: "createAccount",
            args: [accountLogicAddress, initialisationData, index]
        }) as Hex
    ])
}

/**
 * Check the validity of an existing account address, or fetch the pre-deterministic account address for a kernel smart wallet
 * @param client
 * @param entryPoint
 * @param initCodeProvider
 */
const getAccountAddress = async <
    TTransport extends Transport = Transport,
    TChain extends Chain | undefined = Chain | undefined
>({
    client,
    entryPoint,
    initCodeProvider
}: {
    client: Client<TTransport, TChain>
    initCodeProvider: () => Promise<Hex>
    entryPoint: Address
}): Promise<Address> => {
    // Find the init code for this account
    const initCode = await initCodeProvider()

    // Get the sender address based on the init code
    return getSenderAddress(client, {
        initCode,
        entryPoint
    })
}

const signHashedMessage = async <
    TTransport extends Transport = Transport,
    TChain extends Chain | undefined = Chain | undefined
>(
    client: Client<TTransport, TChain>,
    {
        currentValidator,
        account,
        messageHash
    }: {
        currentValidator: KernelPlugin<string, TTransport, TChain>
        account: {
            logicAddress: Address
            address: Address
        }
        messageHash: Hex
    }
): Promise<Hex> => {
    const domain = await client.request({
        method: "eth_call",
        params: [
            {
                to: account.logicAddress,
                data: encodeFunctionData({
                    abi: eip1271Abi,
                    functionName: "eip712Domain"
                })
            },
            "latest"
        ]
    })
    const decoded = decodeFunctionResult({
        abi: [...eip1271Abi],
        functionName: "eip712Domain",
        data: domain
    })

    const encoded = encodeAbiParameters(
        [
            { type: "bytes32" },
            { type: "bytes32" },
            { type: "bytes32" },
            { type: "uint256" },
            { type: "address" }
        ],
        [
            keccak256(
                stringToHex(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                )
            ),
            keccak256(stringToHex(decoded[1])),
            keccak256(stringToHex(decoded[2])),
            decoded[3],
            account.address
        ]
    )

    const domainSeparator = keccak256(encoded)
    const digest = keccak256(
        concatHex(["0x1901", domainSeparator, messageHash])
    )
    return signMessage(client, {
        account: currentValidator.signer,
        message: {
            raw: digest
        }
    })
}

/**
 * Build a kernel smart account from a private key, that use the ECDSA signer behind the scene
 * @param client
 * @param privateKey
 * @param entryPoint
 * @param index
 * @param factoryAddress
 * @param accountLogicAddress
 * @param ecdsaValidatorAddress
 * @param deployedAccountAddress
 */
export async function createKernelAccount<
    TTransport extends Transport = Transport,
    TChain extends Chain | undefined = Chain | undefined
>(
    client: Client<TTransport, TChain>,
    {
        defaultValidator,
        plugin,
        pluginEnableSignature,
        entryPoint = KERNEL_ADDRESSES.ENTRYPOINT_V0_6,
        index = 0n,
        factoryAddress = KERNEL_ADDRESSES.FACTORY_ADDRESS,
        accountLogicAddress = KERNEL_ADDRESSES.ACCOUNT_V2_3_LOGIC,
        deployedAccountAddress,
        initCode
    }: {
        defaultValidator?: KernelPlugin<string, TTransport, TChain>
        plugin?: KernelPlugin<string, TTransport, TChain>
        pluginEnableSignature?: Hex
        entryPoint?: Address
        index?: bigint
        factoryAddress?: Address
        accountLogicAddress?: Address
        deployedAccountAddress?: Address
        initCode?: Hex
    }
): Promise<KernelSmartAccount<TTransport, TChain>> {
    if (!defaultValidator && !plugin)
        throw new Error(
            "You must provide at least defaultValidator or plugin for the kernel smart account"
        )
    const currentValidator =
        plugin ?? (defaultValidator as KernelPlugin<string, TTransport, TChain>)
    // Helper to generate the init code for the smart account
    const generateInitCode = () => {
        if (initCode) return Promise.resolve(initCode)
        else if (defaultValidator)
            return getAccountInitCode({
                owner: defaultValidator.signer.address,
                index,
                factoryAddress,
                accountLogicAddress,
                validatorAddress: defaultValidator.address,
                enableData: defaultValidator.getEnableData()
            })
        else throw new Error("No init code or default validator provided")
    }

    // Fetch account address and chain id
    const [accountAddress] = await Promise.all([
        deployedAccountAddress ??
            getAccountAddress<TTransport, TChain>({
                client,
                entryPoint,
                initCodeProvider: generateInitCode
            })
    ])

    if (!accountAddress) throw new Error("Account address not found")

    // Build the EOA Signer
    const account = toAccount({
        address: accountAddress,
        async signMessage({ message }) {
            let messageHash: Hex
            if (typeof message === "string")
                messageHash = keccak256(stringToHex(message))
            else messageHash = keccak256(message.raw)
            return signHashedMessage(client, {
                currentValidator,
                account: {
                    address: accountAddress,
                    logicAddress: accountLogicAddress
                },
                messageHash
            })
        },
        async signTransaction(_, __) {
            throw new SignTransactionNotSupportedBySmartAccount()
        },
        async signTypedData(typedData) {
            const types = {
                EIP712Domain: getTypesForEIP712Domain({
                    domain: typedData.domain
                }),
                ...typedData.types
            }

            // Need to do a runtime validation check on addresses, byte ranges, integer ranges, etc
            // as we can't statically check this with TypeScript.
            validateTypedData({
                domain: typedData.domain,
                message: typedData.message,
                primaryType: typedData.primaryType,
                types: types
            } as TypedDataDefinition)

            const typedHash = hashTypedData(typedData)
            return await signHashedMessage(client, {
                currentValidator,
                account: {
                    address: accountAddress,
                    logicAddress: accountLogicAddress
                },
                messageHash: typedHash
            })
        }
    })

    const getPluginEnableSignature = () => {
        if (pluginEnableSignature) return Promise.resolve(pluginEnableSignature)
        else if (plugin && defaultValidator)
            return defaultValidator.getPluginEnableSignature(
                accountAddress,
                plugin
            )
        return Promise.resolve(undefined)
    }

    return {
        ...account,
        client: client,
        publicKey: accountAddress,
        entryPoint: entryPoint,
        source: "kernelSmartAccount",

        // Get the nonce of the smart account
        async getNonce() {
            return getAccountNonce(client, {
                sender: accountAddress,
                entryPoint: entryPoint
            })
        },
        defaultValidator,
        plugin,
        getPluginEnableSignature,

        // Sign a user operation
        async signUserOperation(userOperation) {
            const pluginEnableSignature = await getPluginEnableSignature()
            return currentValidator.signUserOperation(
                userOperation,
                pluginEnableSignature
            )
        },
        generateInitCode,

        // Encode the init code
        async getInitCode() {
            const contractCode = await getBytecode(client, {
                address: accountAddress
            })

            if ((contractCode?.length ?? 0) > 2) return "0x"

            return generateInitCode()
        },

        // Encode the deploy call data
        async encodeDeployCallData(_tx) {
            return encodeFunctionData({
                abi: KernelExecuteAbi,
                functionName: "executeDelegateCall",
                args: [
                    createCallAddress,
                    encodeFunctionData({
                        abi: createCallAbi,
                        functionName: "performCreate",
                        args: [
                            0n,
                            encodeDeployData({
                                abi: _tx.abi,
                                bytecode: _tx.bytecode,
                                args: _tx.args
                            } as EncodeDeployDataParameters)
                        ]
                    })
                ]
            })
        },

        // Encode a call
        async encodeCallData(_tx) {
            const tx = _tx as KernelEncodeCallDataArgs
            if (Array.isArray(tx)) {
                // Encode a batched call
                return encodeFunctionData({
                    abi: KernelExecuteAbi,
                    functionName: "executeBatch",
                    args: [
                        tx.map((txn) => {
                            if (txn.callType === "delegatecall") {
                                throw new Error("Cannot batch delegatecall")
                            }
                            return {
                                to: txn.to,
                                value: txn.value,
                                data: txn.data
                            }
                        })
                    ]
                })
            }

            // Default to `call`
            if (!tx.callType || tx.callType === "call") {
                if (
                    tx.to.toLowerCase() === accountAddress &&
                    currentValidator.shouldDelegateViaFallback()
                ) {
                    return tx.data
                }
                return encodeFunctionData({
                    abi: KernelExecuteAbi,
                    functionName: "execute",
                    args: [tx.to, tx.value, tx.data, 0]
                })
            }

            if (tx.callType === "delegatecall") {
                return encodeFunctionData({
                    abi: KernelExecuteAbi,
                    functionName: "executeDelegateCall",
                    args: [tx.to, tx.data]
                })
            }

            throw new Error("Invalid call type")
        },

        // Get simple dummy signature
        async getDummySignature(userOperation) {
            const pluginEnableSignature = await getPluginEnableSignature()
            return currentValidator.getDummySignature(
                userOperation,
                pluginEnableSignature
            )
        }
    }
}
