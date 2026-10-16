// NapCat can time out waiting for an NT event after handing the operation to QQ.
// Its failed response is not proof that the underlying operation was rejected.
export function isNapCatEventTimeout(detail: unknown): boolean {
  return typeof detail === 'string' && /\bTimeout(?:Error)?\s*:\s*NTEvent\b/i.test(detail);
}
