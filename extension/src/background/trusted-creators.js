export function normalizeTrustedCreatorResponse(response, creator) {
  const name = typeof creator === "string" ? creator.trim() : "";
  if (!name) return { status: "unavailable", message: "No seller name was found." };
  if (response?.serverChecked !== true) {
    return { status: "unavailable", message: "Trusted creator status was not checked." };
  }
  const storedName = typeof response.username === "string" ? response.username.trim() : "";
  if (storedName.toLocaleLowerCase() === name.toLocaleLowerCase() &&
      response?.trustedCreatorScore === 1) {
    return {
      status: "trusted",
      creator: name,
    };
  }
  return { status: "unknown", creator: name };
}

export function lookupTrustedCreator(assessment, creator) {
  const name = typeof creator === "string" ? creator.trim() : "";
  if (!name) return { status: "unavailable", message: "No seller name was found." };
  return normalizeTrustedCreatorResponse(assessment, name);
}