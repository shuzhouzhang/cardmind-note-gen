export async function awaitAgentHandlerCallback<TArgs extends unknown[]>(
  callback: ((...args: TArgs) => void | Promise<void>) | undefined,
  ...args: TArgs
): Promise<void> {
  await callback?.(...args)
}
