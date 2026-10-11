// The left branding area can collapse independently of right-panel tabs.
const toggleButton = document.getElementById("toggle-sidebar");
const appCard = document.querySelector(".app-card");
const sidebar = document.getElementById("brand-sidebar");
let isCollapsed = false;

function setCollapsed(isCollapsed) {
  if (!toggleButton || !appCard || !sidebar) return;
  appCard.classList.toggle("sidebar-collapsed", isCollapsed);
  document.documentElement.classList.toggle("sidebar-collapsed", isCollapsed);
  sidebar.inert = isCollapsed;
  sidebar.setAttribute("aria-hidden", String(isCollapsed));
  toggleButton.textContent = isCollapsed ? "→" : "←";
  toggleButton.setAttribute("aria-label", isCollapsed ? "Expand sidebar" : "Collapse sidebar");
  toggleButton.setAttribute("aria-expanded", String(!isCollapsed));
}

if (toggleButton && appCard && sidebar) {
  toggleButton.addEventListener("click", () => {
    isCollapsed = !isCollapsed;
    setCollapsed(isCollapsed);
  });
}
