const status = document.querySelector("#connection-status");

async function bootstrap() {
  try {
    const response = await fetch("/api/bootstrap", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Bootstrap failed with status ${response.status}`);
    }
    await response.json();
    status.textContent = "Connected locally. The cast arrives in the next batch.";
  } catch {
    status.textContent = "The local room is unavailable. Try restarting the server.";
  }
}

void bootstrap();
