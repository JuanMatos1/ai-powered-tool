import { useState } from "react";

export default function UploadResume() {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState("idle");
  const [jobUrl, setJobUrl] = useState("");

  function handleFileChange(e) {
    setFile(e.target.files[0]);
    setStatus("uploaded");
  }

  async function handleUpload() {
    if (!file || !jobUrl) return;

    setStatus("uploading");
    const formData = new FormData();
    formData.append("resume", file);
    formData.append("jobUrl", jobUrl);
    try {
      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      if (response.ok) {
        setStatus("success");
      } else {
        setStatus("error");
      }
    } catch (error) {
      console.error("Error uploading file:", error);
      setStatus("error");
    }
  }

  return (
    <div>
      <input type="file" onChange={handleFileChange} />
      <input
        type="url"
        placeholder="Enter job URL"
        value={jobUrl}
        onChange={(e) => setJobUrl(e.target.value)}
      />
      {file && (
        <div>
          <p>File uploaded: {file.name}</p>
          <p>Status: {status}</p>
        </div>
      )}

      {file && jobUrl && status !== "uploading" && (
        <button onClick={handleUpload}>Upload</button>
      )}
    </div>
  );
}
