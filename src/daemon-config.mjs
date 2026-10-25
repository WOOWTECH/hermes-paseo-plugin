/** Keep optional speech downloads opt-in for a managed text-chat service.
 * Existing settings, including an explicit enable, always take precedence.
 */
export function managedFeatures(features = {}) {
  return {
    ...features,
    dictation: { enabled: false, ...features.dictation },
    voiceMode: { enabled: false, ...features.voiceMode },
    webUi: { ...features.webUi, enabled: true },
  };
}
