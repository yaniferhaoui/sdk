import { getEntryPointVersion } from "permissionless"
import type { SmartAccount } from "permissionless/accounts/types"
import type { Middleware } from "permissionless/actions/smartAccount"
import type { EntryPoint, Prettify } from "permissionless/types"
import type { BundlerRpcSchema } from "permissionless/types/bundler"
import {
    http,
    type Chain,
    type Client,
    type ClientConfig,
    type Transport,
    createClient
} from "viem"
import { type KernelSmartAccount } from "../accounts/index.js"
import { getUserOperationGasPrice } from "../actions/account-client/getUserOperationGasPrice.js"
import {
    type KernelAccountClientActions,
    kernelAccountClientActions
} from "./decorators/kernel.js"
import { hasPimlicoAsProvider, setPimlicoAsProvider } from "./utils.js"

export type KernelAccountClient<
    entryPoint extends EntryPoint,
    transport extends Transport = Transport,
    chain extends Chain | undefined = Chain | undefined,
    account extends KernelSmartAccount<entryPoint> | undefined =
        | KernelSmartAccount<entryPoint>
        | undefined
> = Prettify<
    Client<
        transport,
        chain,
        account,
        BundlerRpcSchema<entryPoint>,
        KernelAccountClientActions<entryPoint, chain, account>
    >
>

export type SmartAccountClientConfig<
    entryPoint extends EntryPoint,
    transport extends Transport = Transport,
    chain extends Chain | undefined = Chain | undefined,
    account extends SmartAccount<entryPoint> | undefined =
        | SmartAccount<entryPoint>
        | undefined
> = Prettify<
    Pick<
        ClientConfig<transport, chain, account>,
        "cacheTime" | "chain" | "key" | "name" | "pollingInterval"
    > & {
        account?: account
        bundlerTransport: Transport
    } & Middleware<entryPoint> & {
            entryPoint: entryPoint
        }
>

export const createKernelAccountClient = <
    entryPoint extends EntryPoint,
    TTransport extends Transport,
    TChain extends Chain | undefined = undefined,
    TSmartAccount extends KernelSmartAccount<entryPoint> | undefined =
        | KernelSmartAccount<entryPoint>
        | undefined
>(
    parameters: SmartAccountClientConfig<
        entryPoint,
        TTransport,
        TChain,
        TSmartAccount
    >
): KernelAccountClient<entryPoint, TTransport, TChain, TSmartAccount> => {
    const {
        key = "Account",
        name = "Kernel Account Client",
        bundlerTransport,
        entryPoint
    } = parameters
    const entryPointVersion = getEntryPointVersion(entryPoint)
    const shouldIncludePimlicoProvider =
        bundlerTransport({}).config.key === "http" &&
        entryPointVersion === "v0.7"

    const client = createClient({
        ...parameters,
        key,
        name,
        transport: (opts) => {
            let _bundlerTransport = bundlerTransport({
                ...opts,
                retryCount: 0
            })
            if (!shouldIncludePimlicoProvider) return _bundlerTransport
            _bundlerTransport = http(
                setPimlicoAsProvider(_bundlerTransport.value?.url)
            )({ ...opts, retryCount: 0 })
            return _bundlerTransport
        },
        type: "kernelAccountClient"
    })

    let middleware = parameters.middleware
    if (
        (!middleware ||
            (typeof middleware !== "function" && !middleware.gasPrice)) &&
        client.transport?.url &&
        hasPimlicoAsProvider(client.transport.url)
    ) {
        const gasPrice = () => getUserOperationGasPrice(client)
        middleware = {
            ...middleware,
            gasPrice
        }
    }
    return client.extend(
        kernelAccountClientActions({
            middleware
        })
    ) as KernelAccountClient<entryPoint, TTransport, TChain, TSmartAccount>
}
