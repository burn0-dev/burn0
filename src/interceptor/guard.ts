let patched = false

export function canPatch(): boolean {
  return !patched
}

export function markPatched(): void {
  patched = true
}

export function resetGuard(): void {
  patched = false
}
