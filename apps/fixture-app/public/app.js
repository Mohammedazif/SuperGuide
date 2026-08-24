(function () {
  "use strict";

  function readForm(form, keys) {
    var payload = {};
    keys.forEach(function (key) {
      var input = form.querySelector("#" + key);
      if (input === null) return;
      payload[key] = input.type === "checkbox" ? input.checked : input.value;
    });
    return payload;
  }

  function bind(formId, statusId, keys, send) {
    var form = document.getElementById(formId);
    if (form === null) return;
    var status = document.getElementById(statusId);

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var accountId = form.getAttribute("data-account");
      send(accountId, readForm(form, keys))
        .then(function (response) {
          if (!response.ok) throw new Error("request failed with " + response.status);
          if (status !== null) status.textContent = "Saved";
          form.setAttribute("data-saved", "true");
        })
        .catch(function (error) {
          if (status !== null) status.textContent = "Could not save: " + error.message;
          form.setAttribute("data-saved", "false");
        });
    });
  }

  bind(
    "billing-form",
    "billing-status",
    ["line1", "line2", "city", "postal_code", "country"],
    function (accountId, payload) {
      if (payload.line2 === "") payload.line2 = null;
      return fetch("/api/v1/accounts/" + accountId + "/billing-address", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
    }
  );

  bind("sso-form", "sso-status", ["sso_enabled", "enforced_domain"], function (accountId, payload) {
    return fetch("/api/v1/accounts/" + accountId + "/sso", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: payload.sso_enabled === true,
        enforced_domain: payload.enforced_domain === "" ? null : payload.enforced_domain
      })
    });
  });
})();
