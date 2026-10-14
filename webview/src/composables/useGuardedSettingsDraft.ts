import { computed, shallowRef, watch } from 'vue';

type DraftFields = Record<string, string | boolean>;

function sameFields<T extends DraftFields>(left: T, right: T): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key]);
}

/** A flat, local form draft. Incoming snapshots update the baseline, never newer local edits. */
export function useGuardedSettingsDraft<T extends DraftFields>(
  readScope: () => string,
  readSaved: () => T
) {
  const draft = shallowRef<T>({ ...readSaved() });
  const saved = shallowRef<T>({ ...readSaved() });
  const externalChange = shallowRef(false);
  const editRevision = shallowRef(0);
  const acknowledgedEditRevision = shallowRef(0);
  const submission = shallowRef<{ revision: number; value: T; requestId: string }>();
  const value = computed({
    get: () => draft.value,
    set: (incoming: T) => {
      if (!sameFields(draft.value, incoming)) editRevision.value++;
      draft.value = { ...incoming };
    }
  });
  const dirty = computed(() => editRevision.value > acknowledgedEditRevision.value || !sameFields(value.value, saved.value));
  const remoteChanged = computed(() => dirty.value && externalChange.value);
  let scope: string | undefined;
  // Only this editor's unsaved scopes survive object switches. Unmounting the settings view
  // releases them; this is not a global conversation cache.
  const draftsByScope = new Map<string, {
    draft: T; saved: T; externalChange: boolean; editRevision: number;
    acknowledgedEditRevision: number; submission: typeof submission.value;
  }>();

  function reset(): void {
    const incoming = { ...readSaved() };
    saved.value = incoming;
    draft.value = { ...incoming };
    externalChange.value = false;
    acknowledgedEditRevision.value = editRevision.value;
    submission.value = undefined;
  }

  function markSubmitted(requestId: string): void {
    if (dirty.value || submission.value) submission.value = { revision: editRevision.value, value: { ...value.value }, requestId };
  }

  function confirmSubmitted(requestId: string): void {
    const sent = submission.value;
    if (!sent || sent.requestId !== requestId) return;
    if (editRevision.value === sent.revision) draft.value = { ...saved.value };
    acknowledgedEditRevision.value = sent.revision;
    submission.value = undefined;
    if (!dirty.value) externalChange.value = false;
  }

  /** Explicit reads reset only their original scope, without overwriting later edits there. */
  function prepareReset(): () => void {
    const revision = editRevision.value;
    const binding = scope;
    return () => {
      if (scope === binding) {
        if (revision === editRevision.value) reset();
      } else if (binding !== undefined && draftsByScope.get(binding)?.editRevision === revision) {
        draftsByScope.delete(binding);
      }
    };
  }

  watch([readScope, readSaved], ([nextScope, incoming]) => {
    if (scope === nextScope && sameFields(saved.value, incoming)) return;
    if (scope !== nextScope) {
      if (scope !== undefined) {
        if (dirty.value || submission.value) draftsByScope.set(scope, {
          draft: { ...draft.value }, saved: { ...saved.value }, externalChange: externalChange.value,
          editRevision: editRevision.value, acknowledgedEditRevision: acknowledgedEditRevision.value,
          submission: submission.value
        });
        else draftsByScope.delete(scope);
      }
      const previous = draftsByScope.get(nextScope);
      draftsByScope.delete(nextScope);
      draft.value = { ...(previous?.draft ?? incoming) };
      saved.value = { ...(previous?.saved ?? incoming) };
      editRevision.value = previous?.editRevision ?? 0;
      acknowledgedEditRevision.value = previous?.acknowledgedEditRevision ?? 0;
      externalChange.value = previous?.externalChange ?? false;
      submission.value = previous?.submission;
      scope = nextScope;
    }
    const sent = submission.value;
    const preserveSubmission = !!sent && (editRevision.value > sent.revision || !sameFields(sent.value, incoming));
    if (!dirty.value && !preserveSubmission) {
      draft.value = { ...incoming };
      acknowledgedEditRevision.value = editRevision.value;
      externalChange.value = false;
    } else if (!sameFields(saved.value, incoming)) {
      externalChange.value = true;
    }
    saved.value = { ...incoming };
  }, { immediate: true, flush: 'sync' });

  return { value, dirty, remoteChanged, reset, markSubmitted, confirmSubmitted, prepareReset };
}
