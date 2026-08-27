const form = document.querySelector("#scannerForm");
const result = document.querySelector("#result");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  result.textContent = "Downloading the job posting and analyzing the PDF...";

  try {
    const response = await fetch("/scanner", { method: "POST", body: new FormData(form) });
    const data = await response.json();
    result.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : "Request failed.";
  }
});
