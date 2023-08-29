(function() {
  const panel = this.window.document.getElementById("info-panel")
  if (panel) {
    fetch("/api/users", {
      method: "GET",
      headers: {
        "Content-Type": "application/json"
      },
      cache: "no-cache"
    }).then(res => {
      if (res.status === 200) {
        res.json().then(data => {
          if (data.length === 0) {
            panel.innerHTML += `<div class="list-item"><div class="list-item-title"></div><div class="list-item-content"><p>No users found</p></div></div>`
          } else {
            for (let i = 0; i < data.length; i++) {
              panel.innerHTML += `<div class="list-item"><div class="list-item-title"></div><div class="list-item-content"><p>${data[i].email}</p><div class="list-item-remove" onclick="removeUser('${data[i].email}');">✕</div></div></div>`
            }
          }
        })
      } else {
        panel.innerHTML += `<div class="list-item"><div class="list-item-title"></div><div class="list-item-content"><p>Failed to get users</p></div></div>`
      }
    })
  }
})()