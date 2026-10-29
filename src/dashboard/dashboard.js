(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var POLL_STATUS_MS = 2000;
  var POLL_LOGS_MS = 1000;
  var POLL_ERRORS_MS = 2000;
  var MAX_LOG_ROWS = 1500;
  var MAX_ERROR_CARDS = 200;

  var state = {
    token: "",
    online: false,
    bridge: null,
    clients: [],
    selected: "auto",
    tab: "logs",
    startedAt: 0,
    authPrompted: false
  };

  /* Browser storage can be blocked, so every access is wrapped. */
  function store(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
    } catch (e) { /* ignore */ }
    return null;
  }
  function session(key, value) {
    try {
      if (value === undefined) return window.sessionStorage.getItem(key);
      window.sessionStorage.setItem(key, value);
    } catch (e) { /* ignore */ }
    return null;
  }

  function ApiError(kind, message, status) {
    this.kind = kind;
    this.message = message;
    this.status = status || 0;
  }

  function api(method, path, body, timeoutMs) {
    var headers = { "x-superbase-client": "dashboard" };
    if (state.token) headers["x-bridge-token"] = state.token;
    if (body !== undefined) headers["content-type"] = "application/json";

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 20000);

    return fetch(path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store"
    }).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (data) {
        if (response.status === 401) throw new ApiError("auth", "The bridge needs a token.", 401);
        if (!response.ok) throw new ApiError("http", (data && data.error) || ("HTTP " + response.status), response.status);
        return data;
      });
    }, function (error) {
      if (error && error.name === "AbortError") throw new ApiError("offline", "The bridge did not answer in time.");
      throw new ApiError("offline", "Cannot reach the bridge.");
    }).then(function (data) {
      clearTimeout(timer);
      return data;
    }, function (error) {
      clearTimeout(timer);
      throw error;
    });
  }

  function clientParam() {
    return state.selected !== "auto" ? state.selected : undefined;
  }

  function pad(number, size) {
    var text = String(number);
    while (text.length < size) text = "0" + text;
    return text;
  }
  function clock(ms) {
    var d = new Date(ms);
    return pad(d.getHours(), 2) + ":" + pad(d.getMinutes(), 2) + ":" + pad(d.getSeconds(), 2) + "." + pad(d.getMilliseconds(), 3);
  }
  function duration(seconds) {
    if (seconds < 60) return seconds + "s";
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "m " + (seconds % 60) + "s";
    return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
  }
  function ago(ms) {
    if (ms < 1500) return "just now";
    return duration(Math.round(ms / 1000)) + " ago";
  }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  /* One place for every empty, loading and error box: an icon, an optional title, and a line of text. */
  function setState(box, kind, iconName, title, detail) {
    box.className = "state-box" + (kind ? " " + kind : "");
    box.textContent = "";
    box.appendChild(icon(iconName));
    if (title) box.appendChild(el("strong", "", title));
    if (detail) box.appendChild(document.createTextNode(detail));
    box.hidden = false;
  }

  /* Icons are ligature fonts: the icon name written as text becomes the glyph. */
  function icon(name, extraClass) {
    var node = el("span", "i" + (extraClass ? " " + extraClass : ""), name);
    node.setAttribute("aria-hidden", "true");
    return node;
  }
  /* Changes the label of a button that has an icon, optionally with a new icon. */
  function setButton(button, label, iconName) {
    var text = button.querySelector(".lbl");
    var glyph = button.querySelector(".i");
    if (text) text.textContent = label;
    if (glyph && iconName) glyph.textContent = iconName;
  }
  function buildButton(className, label, iconName) {
    var button = el("button", className);
    button.type = "button";
    button.appendChild(icon(iconName));
    button.appendChild(el("span", "lbl", label));
    return button;
  }
  var CLASS_ICONS = {
    Folder: "folder", Model: "three-box-flowchart", Workspace: "globe-simplified", Players: "two-people", Player: "person",
    Script: "code", LocalScript: "code", ModuleScript: "code",
    RemoteEvent: "paper-airplane", RemoteFunction: "paper-airplane", BindableEvent: "paper-airplane",
    ScreenGui: "rectangle-list", Frame: "rectangle-list", TextLabel: "text-t-serif", TextButton: "rectangle-cursor",
    Sound: "speaker", Camera: "video-camera", Lighting: "sun", Terrain: "wheat"
  };
  function classIcon(className) {
    return CLASS_ICONS[className] || "cube";
  }
  /* The icon font is checked once. Until it is there the icons stay hidden, and if it never loads they stay hidden. */
  function watchIconFont() {
    if (!document.fonts || !document.fonts.load) return;
    Promise.all([document.fonts.load('18px "Builder Icons"', "gear"), document.fonts.load('18px "Builder Icons Filled"', "gear")]).then(function (loaded) {
      var root = document.documentElement;
      root.classList.add(loaded[0] && loaded[0].length > 0 ? "icons-ready" : "icons-missing");
    }, function () {
      /* The page works without icons: they are removed from the layout. */
      document.documentElement.classList.add("icons-missing");
    });
  }
  function describeValue(value) {
    if (value === null || value === undefined) return "nil";
    if (typeof value === "string") return value;
    if (typeof value === "object") return JSON.stringify(value, null, 2);
    return String(value);
  }

  /* ------------------------------------------------------------ theme */
  function effectiveTheme() {
    var set = document.documentElement.getAttribute("data-theme");
    if (set) return set;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function renderTheme() {
    var dark = effectiveTheme() === "dark";
    setButton($("theme"), dark ? "Light theme" : "Dark theme", dark ? "sun" : "moon");
  }
  function initTheme() {
    var saved = store("superbase-theme");
    if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
    renderTheme();
    $("theme").addEventListener("click", function () {
      var next = effectiveTheme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      store("superbase-theme", next);
      renderTheme();
    });
    if (window.matchMedia) {
      var query = window.matchMedia("(prefers-color-scheme: dark)");
      var listener = function () { renderTheme(); };
      if (query.addEventListener) query.addEventListener("change", listener);
    }
  }

  /* ----------------------------------------------------------- banner */
  var bannerAction = null;
  function showBanner(kind, text, actionLabel, action) {
    var banner = $("banner");
    banner.className = "banner " + kind;
    $("banner-text").textContent = text;
    $("banner-icon").textContent = kind === "error" ? "triangle-exclamation" : "circle-i";
    var button = $("banner-action");
    if (actionLabel) {
      button.textContent = actionLabel;
      button.hidden = false;
      bannerAction = action;
    } else {
      button.hidden = true;
      bannerAction = null;
    }
    banner.hidden = false;
  }
  function hideBanner() { $("banner").hidden = true; }
  $("banner-action").addEventListener("click", function () { if (bannerAction) bannerAction(); });

  /* ------------------------------------------------------------ token */
  function askForToken(failed) {
    var dialog = $("token-dialog");
    $("token-error").hidden = !failed;
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
      $("token-input").focus();
    }
  }
  $("token-cancel").addEventListener("click", function () {
    $("token-dialog").close();
    showBanner("error", "The bridge needs a token, so this page cannot show any data.", "Enter token", function () { askForToken(false); });
  });
  $("token-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var value = $("token-input").value.trim();
    if (!value) return;
    state.token = value;
    session("superbase-token", value);
    $("token-dialog").close();
    $("token-input").value = "";
    state.authPrompted = false;
    refreshStatus();
  });

  /* ----------------------------------------------------------- status */
  function resetData() {
    logs.rows = [];
    logs.lastId = 0;
    logs.lastTime = 0;
    logs.loaded = false;
    $("log-list").textContent = "";
    errors.lastId = 0;
    errors.lastTime = 0;
    errors.loaded = false;
    errors.items = [];
    $("error-list").textContent = "";
    renderLogs();
    renderErrors();
  }

  function refreshStatus() {
    return api("GET", "/status", undefined, 6000).then(function (status) {
      var wasOffline = !state.online;
      state.online = true;
      state.authPrompted = false;
      if (wasOffline) {
        hideBanner();
        renderLogs();
        renderErrors();
        pollLogs();
        pollErrors();
      }

      var startedAt = Date.now() - status.bridgeUptimeSec * 1000;
      if (state.startedAt && Math.abs(startedAt - state.startedAt) > 6000) {
        resetData();
      }
      state.startedAt = startedAt;

      state.bridge = status;
      state.clients = status.clients || [];
      if (state.selected !== "auto" && !state.clients.some(function (c) { return c.id === state.selected; })) {
        showBanner("info", "Client " + state.selected + " disconnected. Using the newest client instead.", "Dismiss", hideBanner);
        state.selected = "auto";
      }
      renderStatus();
      renderClients();
      renderAvailability();
    }, function (error) {
      if (error.kind === "auth") {
        state.online = false;
        if (!state.authPrompted) {
          state.authPrompted = true;
          askForToken(Boolean(state.token));
        }
        return;
      }
      state.online = false;
      state.clients = [];
      showBanner("error", "Cannot reach the bridge. Is it running? Start it with npm start. This page keeps retrying.", "Retry now", refreshStatus);
      setBridge("offline", "Bridge offline", ["Start it with npm start."]);
      renderClients();
      renderAvailability();
    });
  }

  function renderStatus() {
    var b = state.bridge;
    if (!b) return;
    setBridge("online", "Bridge " + b.bridgeVersion, [
      "Up " + duration(b.bridgeUptimeSec) + ", " + b.mode + " mode",
      state.clients.length + (state.clients.length === 1 ? " client" : " clients"),
      "Local only, " + location.host
    ]);

    $("count-logs").textContent = String(b.logCount);
    $("count-errors").textContent = String(b.errorCount);
    $("count-errors").className = "count" + (b.errorCount > 0 ? " has-errors" : "");
  }

  /* The bridge block in the rail: a status dot, a title and a few detail lines. */
  function setBridge(kind, title, details) {
    var info = $("bridge-info");
    info.setAttribute("data-state", kind);
    info.textContent = "";
    var name = el("span", "name");
    name.appendChild(el("span", "dot"));
    name.lastChild.setAttribute("aria-hidden", "true");
    name.appendChild(el("strong", "", title));
    info.appendChild(name);
    details.forEach(function (line) { info.appendChild(el("span", "detail", line)); });
  }

  function selectedClientInfo() {
    if (state.selected !== "auto") {
      return state.clients.filter(function (c) { return c.id === state.selected; })[0] || null;
    }
    return state.clients.filter(function (c) { return c.isDefault; })[0] || state.clients[state.clients.length - 1] || null;
  }

  function renderClients() {
    var box = $("clients");

    /* Keep keyboard focus on the same chip when the strip is rebuilt by the poll. */
    var focused = document.activeElement && document.activeElement.parentNode === box ? document.activeElement.getAttribute("data-id") : null;
    var kind = !state.online ? "offline" : state.clients.length === 0 ? "empty" : "list";
    if (kind !== "list" && box.getAttribute("data-kind") === kind) return;
    box.setAttribute("data-kind", kind);
    box.textContent = "";
    $("clients-hint").hidden = kind !== "list";

    if (!state.online) {
      var offline = el("div", "loader-box");
      var offlineTitle = el("strong");
      offlineTitle.appendChild(icon("circle-slash"));
      offlineTitle.appendChild(el("span", "", "The bridge is not reachable."));
      offline.appendChild(offlineTitle);
      offline.appendChild(el("p", "muted", "Start it with npm start in the Superbase folder. Clients show up here as soon as it runs."));
      box.appendChild(offline);
      return;
    }

    if (state.clients.length === 0) {
      var empty = el("div", "loader-box");
      var emptyTitle = el("strong");
      emptyTitle.appendChild(icon("circle-dashed"));
      emptyTitle.appendChild(el("span", "", "No Roblox client is connected yet."));
      empty.appendChild(emptyTitle);
      empty.appendChild(el("p", "muted", "Join a game and run this in your executor:"));
      var line = el("div", "loader-line");
      var loader = state.bridge && state.bridge.clientUrl ? 'loadstring(game:HttpGet("' + state.bridge.clientUrl + '"))()' : "Execute roblox/client.lua in your executor.";
      line.appendChild(el("code", "", loader));
      if (state.bridge && state.bridge.clientUrl) {
        var copy = buildButton("btn", "Copy", "two-stacked-squares");
        copy.addEventListener("click", function () { copyText(loader, copy); });
        line.appendChild(copy);
      }
      empty.appendChild(line);
      box.appendChild(empty);
      return;
    }

    var auto = el("button", "client");
    auto.type = "button";
    auto.setAttribute("data-id", "auto");
    auto.setAttribute("aria-pressed", state.selected === "auto" ? "true" : "false");
    auto.appendChild(icon("clock"));
    var autoStack = el("span", "stack");
    autoStack.appendChild(el("span", "who", "Automatic"));
    autoStack.appendChild(el("span", "meta", "Always the newest client"));
    auto.appendChild(autoStack);
    auto.addEventListener("click", function () { selectClient("auto"); });
    if (state.clients.length > 1) box.appendChild(auto);

    state.clients.forEach(function (client) {
      var card = el("button", "client");
      card.type = "button";
      card.setAttribute("data-id", client.id);
      card.setAttribute("aria-pressed", state.selected === client.id ? "true" : "false");
      var dot = el("span", "dot");
      dot.setAttribute("aria-hidden", "true");
      card.appendChild(dot);
      var stack = el("span", "stack");
      stack.appendChild(el("span", "who", (client.userName || "Unknown player") + " (" + client.id + ")"));
      var details = [];
      if (client.placeId) details.push("Place " + client.placeId);
      if (client.executor) details.push(client.executor);
      if (typeof client.latencyMs === "number") details.push(client.latencyMs + " ms");
      stack.appendChild(el("span", "meta", details.join(", ") || "No details"));
      card.appendChild(stack);
      if (client.isDefault) card.appendChild(el("span", "tag", "Newest"));
      card.title = "Seen " + ago(client.lastSeenMsAgo);
      card.addEventListener("click", function () { selectClient(client.id); });
      box.appendChild(card);
    });

    if (focused) {
      var again = box.querySelector('[data-id="' + focused + '"]');
      if (again) again.focus();
    }

    $("clients-hint").textContent = state.selected === "auto"
      ? "Tools use the newest client. Pick one to lock it."
      : "Tools use " + state.selected + ".";
  }

  function selectClient(id) {
    state.selected = id;
    renderClients();
    renderAvailability();
    renderLogs();
    renderErrors();
  }

  function copyText(text, button) {
    var done = function (message, iconName) {
      var label = button.querySelector(".lbl");
      var old = label.textContent;
      var oldIcon = button.querySelector(".i").textContent;
      setButton(button, message, iconName);
      setTimeout(function () { setButton(button, old, oldIcon); }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done("Copied", "check"); }, function () { done("Select and copy", "circle-i"); });
    } else {
      done("Select and copy", "circle-i");
    }
  }

  /* Run and Open need a connected client. */
  function renderAvailability() {
    var has = state.online && Boolean(selectedClientInfo());
    $("lua-run").disabled = !has;
    $("explorer-go").disabled = !has;
    $("props-form").querySelector("button").disabled = !has;
    $("lua-hint").textContent = has
      ? "Code runs with your executor's full permissions."
      : "Connect a Roblox client to run code.";
    /* Idle text only. A loading or error message in the same box must not be replaced by the status poll. */
    if (!explorer.loaded && !explorer.busy && !explorer.failed) {
      setState($("explorer-state"), "", "three-box-flowchart", "", has ? "Open a path to look around." : "Connect a Roblox client, then open a path.");
    }
  }

  /* ------------------------------------------------------------- tabs */
  var tabNames = ["logs", "errors", "console", "explorer", "screenshot"];
  function selectTab(name, focus) {
    state.tab = name;
    tabNames.forEach(function (tabName) {
      var selected = tabName === name;
      var tab = $("tab-" + tabName);
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.tabIndex = selected ? 0 : -1;
      $("panel-" + tabName).hidden = !selected;
      if (selected && focus) tab.focus();
    });
    if (name === "logs") pollLogs();
    if (name === "errors") pollErrors();
    if (name !== "screenshot") stopLive();
    if (name === "explorer" && !explorer.loaded && selectedClientInfo()) loadExplorer($("explorer-path").value);
    store("superbase-tab", name);
  }
  tabNames.forEach(function (name, index) {
    var tab = $("tab-" + name);
    tab.addEventListener("click", function () { selectTab(name, false); });
    tab.addEventListener("keydown", function (event) {
      var target = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") target = (index + 1) % tabNames.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") target = (index + tabNames.length - 1) % tabNames.length;
      else if (event.key === "Home") target = 0;
      else if (event.key === "End") target = tabNames.length - 1;
      if (target !== null) {
        event.preventDefault();
        selectTab(tabNames[target], true);
      }
    });
  });

  /* The tab list is vertical in the rail and horizontal on narrow windows. */
  if (window.matchMedia) {
    var narrow = window.matchMedia("(max-width: 820px)");
    var setOrientation = function () {
      document.querySelector('[role="tablist"]').setAttribute("aria-orientation", narrow.matches ? "horizontal" : "vertical");
    };
    setOrientation();
    if (narrow.addEventListener) narrow.addEventListener("change", setOrientation);
  }

  /* ------------------------------------------------------------- logs */
  var logs = { rows: [], lastId: 0, lastTime: 0, loaded: false, paused: false, busy: false, failed: null };

  function logVisible(entry) {
    var level = $("log-level").value;
    var text = $("log-search").value.trim().toLowerCase();
    if (state.selected !== "auto" && entry.client !== state.selected) return false;
    if (level && entry.level !== level) return false;
    if (text && (entry.message + " " + entry.client).toLowerCase().indexOf(text) === -1) return false;
    return true;
  }

  function buildLogRow(entry) {
    var row = el("div", "log-row mono " + entry.level + (entry.history ? " history" : ""));
    var head = el("span", "head");
    head.appendChild(el("span", "t", clock(entry.time)));
    head.appendChild(el("span", "lvl", entry.level));
    head.appendChild(el("span", "c", entry.client || ""));
    row.appendChild(head);
    row.appendChild(el("span", "m", entry.message));
    return row;
  }

  function renderLogs() {
    var list = $("log-list");
    var stateBox = $("log-state");
    var shown = 0;

    list.textContent = "";
    logs.rows.forEach(function (entry) {
      if (logVisible(entry)) {
        list.appendChild(buildLogRow(entry));
        shown += 1;
      }
    });

    if (logs.failed) {
      setState(stateBox, "error", "triangle-exclamation", "", logs.failed);
      list.hidden = true;
    } else if (!logs.loaded) {
      setState(stateBox, "", "arrow-rotate-right", "", state.online ? "Loading logs..." : "Waiting for the bridge...");
      list.hidden = true;
    } else if (shown === 0) {
      setState(
        stateBox, "", "rectangle-list",
        logs.rows.length === 0 ? "No console lines yet." : "No lines match the filters.",
        logs.rows.length === 0 ? "Output from the game appears here as it happens." : logs.rows.length + " stored lines are hidden by the level, search or client filter."
      );
      list.hidden = true;
    } else {
      stateBox.hidden = true;
      list.hidden = false;
      if ($("log-scroll").checked) list.scrollTop = list.scrollHeight;
    }
    $("log-count").textContent = logs.loaded ? "Showing " + shown + " of " + logs.rows.length + " lines" + (logs.paused ? ". Paused." : ".") : "";
  }

  function appendLogs(fresh) {
    var list = $("log-list");
    fresh.forEach(function (entry) {
      logs.rows.push(entry);
      if (logVisible(entry)) list.appendChild(buildLogRow(entry));
    });
    if (logs.rows.length > MAX_LOG_ROWS) logs.rows.splice(0, logs.rows.length - MAX_LOG_ROWS);
    while (list.childNodes.length > MAX_LOG_ROWS) list.removeChild(list.firstChild);
  }

  function pollLogs() {
    if (!state.online || logs.paused || logs.busy || state.tab !== "logs" || document.hidden) return Promise.resolve();
    logs.busy = true;
    var query = new URLSearchParams({ limit: logs.loaded ? "300" : "500" });
    if (logs.loaded) query.set("since", String(logs.lastTime));
    return api("GET", "/logs?" + query.toString()).then(function (data) {
      var fresh = data.logs.filter(function (entry) { return entry.id > logs.lastId; });
      if (data.logs.length > 0) {
        var last = data.logs[data.logs.length - 1];
        logs.lastId = Math.max(logs.lastId, last.id);
        logs.lastTime = Math.max(logs.lastTime, last.time);
      }
      logs.failed = null;
      if (!logs.loaded) {
        logs.loaded = true;
        logs.rows = fresh;
        renderLogs();
      } else if (fresh.length > 0) {
        var wasEmpty = $("log-list").hidden;
        appendLogs(fresh);
        if (wasEmpty) renderLogs();
        else {
          var listNode = $("log-list");
          if ($("log-scroll").checked) listNode.scrollTop = listNode.scrollHeight;
          $("log-count").textContent = "Showing " + listNode.childNodes.length + " of " + logs.rows.length + " lines.";
        }
      }
    }, function (error) {
      if (error.kind !== "offline" && error.kind !== "auth") {
        logs.failed = "Could not read the logs: " + error.message;
        renderLogs();
      }
    }).then(function () { logs.busy = false; });
  }

  ["log-level", "log-search"].forEach(function (id) {
    $(id).addEventListener("input", renderLogs);
  });
  $("log-scroll").addEventListener("change", function () {
    if (this.checked) { var l = $("log-list"); l.scrollTop = l.scrollHeight; }
  });
  $("log-pause").addEventListener("click", function () {
    logs.paused = !logs.paused;
    setButton(this, logs.paused ? "Resume" : "Pause", logs.paused ? "play-small" : "pause-small");
    this.setAttribute("aria-pressed", logs.paused ? "true" : "false");
    if (!logs.paused) pollLogs();
    renderLogs();
  });
  $("log-clear").addEventListener("click", function () {
    var body = clientParam() ? { client: clientParam() } : {};
    api("POST", "/clear", body).then(function () {
      logs.rows = logs.rows.filter(function (entry) { return clientParam() && entry.client !== clientParam(); });
      renderLogs();
      refreshStatus();
    }, function (error) {
      logs.failed = "Could not clear the logs: " + error.message;
      renderLogs();
    });
  });

  /* ----------------------------------------------------------- errors */
  var errors = { items: [], lastId: 0, lastTime: 0, loaded: false, busy: false, failed: null };

  function errorVisible(item) {
    var text = $("error-search").value.trim().toLowerCase();
    if (state.selected !== "auto" && item.client !== state.selected) return false;
    if (text && (item.message + " " + (item.script || "") + " " + item.trace).toLowerCase().indexOf(text) === -1) return false;
    return true;
  }

  function buildErrorCard(item) {
    var card = el("article", "error-card");
    var head = el("div", "head");
    head.appendChild(el("span", "mono", clock(item.time)));
    if (item.client) head.appendChild(el("span", "", "Client " + item.client));
    if (item.script) head.appendChild(el("span", "mono", item.script));
    card.appendChild(head);
    card.appendChild(el("p", "msg", item.message));
    if (item.trace) card.appendChild(el("pre", "mono", item.trace));
    return card;
  }

  function renderErrors() {
    var list = $("error-list");
    var box = $("error-state");
    list.textContent = "";
    var shown = 0;
    errors.items.slice().reverse().forEach(function (item) {
      if (errorVisible(item)) { list.appendChild(buildErrorCard(item)); shown += 1; }
    });

    if (errors.failed) {
      setState(box, "error", "triangle-exclamation", "", errors.failed);
      list.hidden = true;
    } else if (!errors.loaded) {
      setState(box, "", "arrow-rotate-right", "", state.online ? "Loading errors..." : "Waiting for the bridge...");
      list.hidden = true;
    } else if (shown === 0) {
      setState(
        box, "", "circle-check",
        errors.items.length === 0 ? "No script errors captured." : "No errors match the filters.",
        errors.items.length === 0 ? "Errors from the game's scripts show up here with their stack trace." : errors.items.length + " stored errors are hidden by the search or client filter."
      );
      list.hidden = true;
    } else {
      box.hidden = true;
      list.hidden = false;
    }
  }

  function pollErrors() {
    if (!state.online || errors.busy || state.tab !== "errors" || document.hidden) return Promise.resolve();
    errors.busy = true;
    var query = new URLSearchParams({ limit: "200" });
    if (errors.loaded) query.set("since", String(errors.lastTime));
    return api("GET", "/errors?" + query.toString()).then(function (data) {
      var fresh = data.errors.filter(function (item) { return item.id > errors.lastId; });
      if (data.errors.length > 0) {
        var last = data.errors[data.errors.length - 1];
        errors.lastId = Math.max(errors.lastId, last.id);
        errors.lastTime = Math.max(errors.lastTime, last.time);
      }
      errors.failed = null;
      var changed = !errors.loaded || fresh.length > 0;
      errors.loaded = true;
      errors.items = errors.items.concat(fresh);
      if (errors.items.length > MAX_ERROR_CARDS) errors.items.splice(0, errors.items.length - MAX_ERROR_CARDS);
      if (changed) renderErrors();
    }, function (error) {
      if (error.kind !== "offline" && error.kind !== "auth") {
        errors.failed = "Could not read the errors: " + error.message;
        renderErrors();
      }
    }).then(function () { errors.busy = false; });
  }

  $("error-search").addEventListener("input", renderErrors);
  $("error-clear").addEventListener("click", function () {
    var body = clientParam() ? { client: clientParam() } : {};
    api("POST", "/clear", body).then(function () {
      errors.items = errors.items.filter(function (item) { return clientParam() && item.client !== clientParam(); });
      renderErrors();
      refreshStatus();
    }, function (error) {
      errors.failed = "Could not clear the errors: " + error.message;
      renderErrors();
    });
  });

  /* ---------------------------------------------------------- run Lua */
  var HISTORY_KEY = "superbase-lua-history";
  var luaHistory = [];

  function loadHistory() {
    try { luaHistory = JSON.parse(store(HISTORY_KEY) || "[]"); } catch (e) { luaHistory = []; }
    if (!Array.isArray(luaHistory)) luaHistory = [];
    renderHistory();
  }
  function renderHistory() {
    var select = $("lua-history");
    select.textContent = "";
    var first = el("option", "", luaHistory.length ? "Recent code" : "No recent code");
    first.value = "";
    select.appendChild(first);
    luaHistory.forEach(function (code, index) {
      var option = el("option", "", code.replace(/\s+/g, " ").slice(0, 60));
      option.value = String(index);
      select.appendChild(option);
    });
    select.disabled = luaHistory.length === 0;
  }
  function remember(code) {
    luaHistory = [code].concat(luaHistory.filter(function (item) { return item !== code; })).slice(0, 15);
    store(HISTORY_KEY, JSON.stringify(luaHistory));
    renderHistory();
  }
  $("lua-history").addEventListener("change", function () {
    var item = luaHistory[Number(this.value)];
    if (this.value !== "" && item !== undefined) { $("lua-code").value = item; $("lua-code").focus(); }
    this.value = "";
  });

  function setOutput(text, isError) {
    var out = $("lua-output");
    out.textContent = text;
    out.className = "output mono" + (isError ? " error" : "");
    out.hidden = false;
  }
  function setLuaStatus(text, kind) {
    var line = $("lua-status");
    line.textContent = text;
    line.className = "status-line" + (kind ? " " + kind : "");
  }

  function runLua() {
    var button = $("lua-run");
    var code = $("lua-code").value;
    if (button.disabled) return;
    if (!code.trim()) {
      setLuaStatus("Enter some code first.", "error");
      $("lua-code").focus();
      return;
    }

    var timeout = Number($("lua-timeout").value);
    var body = { code: code, timeout_ms: timeout };
    if (clientParam()) body.client = clientParam();

    button.disabled = true;
    setLuaStatus("Running...", "");
    $("lua-output").hidden = true;
    var started = performance.now();
    remember(code);

    api("POST", "/exec", body, timeout + 5000).then(function (result) {
      var took = Math.round(performance.now() - started) + " ms";
      if (result.ok) {
        var values = result.value || [];
        setOutput(values.length === 0 ? "(no return value)" : values.map(describeValue).join("\n"), false);
        setLuaStatus("Finished in " + took + ".", "ok");
      } else {
        setOutput(result.error || "The code failed.", true);
        setLuaStatus("The code raised an error after " + took + ".", "error");
      }
    }, function (error) {
      setOutput(error.message, true);
      setLuaStatus("Could not run the code.", "error");
    }).then(function () { renderAvailability(); });
  }
  $("lua-run").addEventListener("click", runLua);
  $("lua-code").addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      runLua();
    }
  });
  $("lua-clear").addEventListener("click", function () {
    $("lua-output").hidden = true;
    setLuaStatus("", "");
  });

  /* --------------------------------------------------------- explorer */
  var explorer = { path: "game", loaded: false, busy: false, failed: false };

  function renderCrumbs(path) {
    var nav = $("crumbs");
    nav.textContent = "";
    var parts = path.split(".").filter(Boolean);
    if (parts[0] !== "game") parts.unshift("game");
    parts.forEach(function (part, index) {
      var target = parts.slice(0, index + 1).join(".");
      var button = el("button", "", part);
      button.type = "button";
      if (index === parts.length - 1) button.setAttribute("aria-current", "page");
      else button.addEventListener("click", function () { $("explorer-path").value = target; loadExplorer(target); });
      nav.appendChild(button);
      if (index < parts.length - 1) nav.appendChild(icon("chevron-small-right", "sep"));
    });
  }

  function loadExplorer(path) {
    path = (path || "game").trim() || "game";
    var names = $("props-input").value.split(",").map(function (name) { return name.trim(); }).filter(Boolean);
    var body = { path: path, properties: names };
    if (clientParam()) body.client = clientParam();

    var box = $("explorer-state");
    setState(box, "", "arrow-rotate-right", "", "Loading " + path + "...");
    $("explorer-body").hidden = true;
    explorer.busy = true;
    explorer.failed = false;
    renderCrumbs(path);

    api("POST", "/inspect", body, 30000).then(function (result) {
      if (!result.ok) throw new ApiError("http", result.error || "Could not inspect that path.");
      var info = result.value;
      explorer.path = path;
      explorer.loaded = true;

      var children = $("children");
      children.textContent = "";
      (info.children || []).forEach(function (child) {
        var button = el("button", "child");
        button.type = "button";
        button.appendChild(icon(classIcon(child.className)));
        button.appendChild(el("span", "n", child.name));
        button.appendChild(el("span", "k", child.className));
        if (child.name.indexOf(".") !== -1) {
          button.disabled = true;
          button.title = "Names that contain a dot cannot be opened by path.";
        } else {
          button.addEventListener("click", function () {
            var next = path + "." + child.name;
            $("explorer-path").value = next;
            loadExplorer(next);
          });
        }
        children.appendChild(button);
      });
      if (!children.firstChild) children.appendChild(el("p", "empty", "No children."));
      $("children-title").textContent = "Children (" + (info.children || []).length + (info.childrenTruncated ? "+" : "") + ")";

      var tbody = $("props").querySelector("tbody");
      tbody.textContent = "";
      var keys = Object.keys(info.properties || {});
      keys.forEach(function (key) {
        var row = el("tr");
        row.appendChild(el("th", "", key));
        var cell = el("td");
        cell.appendChild(el("code", "", describeValue(info.properties[key])));
        row.appendChild(cell);
        tbody.appendChild(row);
      });
      var summary = el("tr");
      summary.appendChild(el("th", "", "Class"));
      var summaryCell = el("td");
      summaryCell.appendChild(el("code", "", info.className));
      summary.appendChild(summaryCell);
      tbody.insertBefore(summary, tbody.firstChild);

      box.hidden = true;
      $("explorer-body").hidden = false;
    }).catch(function (error) {
      explorer.failed = true;
      setState(box, "error", "triangle-exclamation", "Could not open " + path, error.message);
      $("explorer-body").hidden = true;
    }).then(function () { explorer.busy = false; });
  }

  $("explorer-form").addEventListener("submit", function (event) {
    event.preventDefault();
    if (!$("explorer-go").disabled) loadExplorer($("explorer-path").value);
  });
  $("props-form").addEventListener("submit", function (event) {
    event.preventDefault();
    if (!$("props-form").querySelector("button").disabled) loadExplorer(explorer.path);
  });

  /* -------------------------------------------------------- screenshot */
  var shot = { busy: false, timer: null };

  function takeShot() {
    if (shot.busy) return Promise.resolve();
    shot.busy = true;
    var button = $("shot-take");
    button.disabled = true;
    var query = new URLSearchParams({ max_width: $("shot-width").value });
    if ($("shot-focus").checked) query.set("focus", "1");
    var status = $("shot-status");
    var startedAt = Date.now();
    status.textContent = "Capturing...";
    status.className = "status-line";

    return api("GET", "/screenshot?" + query.toString(), undefined, 30000).then(function (data) {
      var source = "data:" + data.mimeType + ";base64," + data.data;
      $("shot-img").src = source;
      $("shot-img").hidden = false;
      $("shot-empty").hidden = true;
      var link = $("shot-download");
      link.href = source;
      link.hidden = false;
      status.textContent = data.width + " x " + data.height + (data.title ? ", window: " + data.title : "") + ". Taken at " + clock(Date.now()) + ", took " + ((Date.now() - startedAt) / 1000).toFixed(1) + " s.";
      status.className = "status-line ok";
    }, function (error) {
      status.textContent = error.message;
      status.className = "status-line error";
      if (error.kind === "http") stopLive();
    }).then(function () {
      shot.busy = false;
      button.disabled = false;
    });
  }

  function stopLive() {
    if (shot.timer) { clearInterval(shot.timer); shot.timer = null; }
    $("shot-live").checked = false;
  }
  $("shot-take").addEventListener("click", takeShot);
  $("shot-live").addEventListener("change", function () {
    if (this.checked) {
      takeShot();
      shot.timer = setInterval(function () {
        if (!document.hidden && state.tab === "screenshot") takeShot();
      }, 3000);
    } else {
      stopLive();
    }
  });

  /* ---------------------------------------------------------- logo */
  /* The script loads after the image may already have failed, so check both the event and the current state. */
  (function () {
    var logo = $("logo");
    var hideLogo = function () { logo.hidden = true; };
    logo.addEventListener("error", hideLogo);
    if (logo.complete && logo.naturalWidth === 0) hideLogo();
  })();

  /* ------------------------------------------------------------ start */
  state.token = session("superbase-token") || "";
  watchIconFont();
  initTheme();
  loadHistory();
  renderClients();
  renderAvailability();
  renderLogs();
  renderErrors();
  var savedTab = store("superbase-tab");
  if (savedTab && tabNames.indexOf(savedTab) !== -1) selectTab(savedTab, false);

  refreshStatus();
  setInterval(refreshStatus, POLL_STATUS_MS);
  setInterval(pollLogs, POLL_LOGS_MS);
  setInterval(pollErrors, POLL_ERRORS_MS);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) { refreshStatus(); pollLogs(); pollErrors(); }
  });
})();
