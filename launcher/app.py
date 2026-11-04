"""Desktop sign-in window. All Tk calls stay on the GUI thread."""
from __future__ import annotations

import queue
import logging
import sys
import threading
import time
import webbrowser
import tkinter as tk
from tkinter import simpledialog, ttk

from core import APP_VERSION, VPN_HELP, Cancelled, ConfigurationError, Connection, ConnectionError, Settings


class Launcher:
    def __init__(self, root):
        self.root = root
        self.events = queue.Queue()
        self.connection = None
        self.generation = 0
        self.mode = "idle"
        self.closing = False
        self.settings = None
        root.title("ERA5Viewer Connect")
        root.geometry("570x640")
        root.minsize(510, 610)
        root.configure(bg="#f4f8f5")
        root.protocol("WM_DELETE_WINDOW", self.close)
        style = ttk.Style(root)
        if "clam" in style.theme_names():
            style.theme_use("clam")
        style.configure("TFrame", background="#f4f8f5")
        style.configure("TLabel", background="#f4f8f5", foreground="#183c35", font=("Helvetica", 11))
        style.configure("Title.TLabel", font=("Helvetica", 22, "bold"))
        style.configure("Muted.TLabel", foreground="#5f7a6c", font=("Helvetica", 10))
        style.configure("TButton", padding=(12, 9), font=("Helvetica", 10))
        style.configure("Connect.TButton", background="#0f766e", foreground="white", font=("Helvetica", 11, "bold"))
        style.map("Connect.TButton", background=[("active", "#105c53"), ("disabled", "#89a99b")])
        style.configure("TEntry", padding=8, font=("Helvetica", 12))

        frame = ttk.Frame(root, padding=28)
        frame.pack(fill="both", expand=True)
        frame.columnconfigure(0, weight=1)
        ttk.Label(frame, text="E5   ERA5Viewer Connect", style="Title.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(frame, text="Open your research viewer securely.", style="Muted.TLabel").grid(row=1, column=0, sticky="w", pady=(5, 18))
        self.destination = ttk.Label(frame, text="eepc-0184.bath.ac.uk · SSH", style="Muted.TLabel")
        self.destination.grid(row=2, column=0, sticky="w", pady=(0, 14))
        ttk.Label(frame, text="Bath username").grid(row=3, column=0, sticky="w")
        self.username = tk.StringVar()
        self.user_entry = ttk.Entry(frame, textvariable=self.username)
        self.user_entry.grid(row=4, column=0, sticky="ew", pady=(5, 12))
        ttk.Label(frame, text="Password").grid(row=5, column=0, sticky="w")
        self.password = tk.StringVar()
        self.password_entry = ttk.Entry(frame, textvariable=self.password, show="•")
        self.password_entry.grid(row=6, column=0, sticky="ew", pady=(5, 13))
        self.connect_button = ttk.Button(frame, text="Connect and open viewer", style="Connect.TButton", command=self.connect)
        self.connect_button.grid(row=7, column=0, sticky="ew")
        self.progress = ttk.Progressbar(frame, mode="indeterminate")
        self.progress.grid(row=8, column=0, sticky="ew", pady=(12, 4))
        self.status = tk.StringVar(value="Connect to the Bath VPN first if you are off campus.")
        self.status_label = ttk.Label(frame, textvariable=self.status, wraplength=485, style="Muted.TLabel")
        self.status_label.grid(row=9, column=0, sticky="ew", pady=(3, 9))
        buttons = ttk.Frame(frame)
        buttons.grid(row=10, column=0, sticky="ew")
        ttk.Button(buttons, text="Bath VPN help", command=lambda: webbrowser.open(VPN_HELP)).pack(side="left")
        self.disconnect_button = ttk.Button(buttons, text="Disconnect", command=self.disconnect, state="disabled")
        self.disconnect_button.pack(side="right")
        self.footer=ttk.Label(frame, text="Your password is used only for SSH sign-in and is never saved.", style="Muted.TLabel", wraplength=485)
        self.footer.grid(row=11, column=0, sticky="w", pady=(14, 0))
        try:
            self.settings = Settings.load()
            self.destination.configure(text=self.settings.ssh_host + " · SSH · ERA5 port " + str(self.settings.reader_port))
        except ConfigurationError as exc:
            self.status.set(str(exc))
            self.connect_button.configure(state="disabled")
        root.bind("<Return>", lambda event: self.connect())
        self.user_entry.focus_set()
        self.root.after(100, self.poll)

    def connect(self):
        if self.mode == "connected":
            webbrowser.open_new_tab(self.connection.url)
            return
        if self.mode != "idle" or self.settings is None:
            return
        username, password = self.username.get().strip(), self.password.get()
        if not username or not password:
            self.status.set("Enter your Bath username and password.")
            return
        self.password.set("")
        self.generation += 1
        generation = self.generation
        connection = Connection(self.settings,
            status=lambda message: self.events.put((generation, "status", message)),
            challenge=lambda *args: self.ask_challenge(generation, *args))
        self.connection = connection
        self.mode = "connecting"
        self.user_entry.configure(state="disabled")
        self.password_entry.configure(state="disabled")
        self.connect_button.configure(text="Connecting…", state="disabled")
        self.disconnect_button.configure(text="Cancel", state="normal")
        self.progress.start(12)
        threading.Thread(target=self.connect_worker, args=(generation, connection, username, password), daemon=True).start()
        password = None

    def connect_worker(self, generation, connection, username, password):
        try:
            connection.connect(username, password)
            self.events.put((generation, "ready", connection))
        except Cancelled:
            self.events.put((generation, "error", "Connection cancelled."))
        except ConnectionError as exc:
            self.events.put((generation, "error", str(exc)))
        except Exception:
            connection.close()
            self.events.put((generation, "error", "The connection could not be completed. Please contact the maintainer."))
        finally:
            password = None

    def ask_challenge(self, generation, title, instructions, prompts):
        result = queue.Queue(maxsize=1)
        self.events.put((generation, "challenge", (title, instructions, prompts, result)))
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if self.closing or generation != self.generation:
                return None
            try:
                return result.get(timeout=.2)
            except queue.Empty:
                pass
        return None

    def show_challenge(self, title, instructions, prompts, result):
        answers = []
        for prompt, echo in prompts:
            answer = simpledialog.askstring(title or "Additional SSH sign-in", (instructions + "\n\n" + prompt).strip(), parent=self.root, show="" if echo else "•")
            if answer is None:
                result.put(None)
                return
            answers.append(answer)
        result.put(answers)

    def poll(self):
        if self.closing:
            return
        while True:
            try:
                generation, kind, value = self.events.get_nowait()
            except queue.Empty:
                break
            if generation != self.generation:
                if kind == "ready":
                    threading.Thread(target=value.close, daemon=True).start()
                elif kind == "challenge":
                    value[-1].put(None)
                continue
            if kind == "status":
                self.status.set(value)
            elif kind == "challenge":
                self.show_challenge(*value)
            elif kind == "error":
                self.reset(value)
            elif kind == "ready":
                self.mode = "connected"
                self.progress.stop()
                self.connect_button.configure(text="Open viewer again", state="normal")
                self.disconnect_button.configure(text="Disconnect", state="normal")
                self.status.set("Connected · " + value.url + "\nKeep this window open while using the viewer.")
                try:
                    if not webbrowser.open_new_tab(value.url):
                        self.status.set("Connected. Open " + value.url + " in your browser. Keep this window open.")
                except Exception:
                    self.status.set("Connected. Open " + value.url + " in your browser. Keep this window open.")
        if self.mode == "connected" and not self.connection.is_active:
            self.disconnect("The connection ended. Reconnect to the Bath VPN if needed, then connect again.")
        self.root.after(150, self.poll)

    def reset(self, message):
        self.mode = "idle"
        self.progress.stop()
        self.user_entry.configure(state="normal")
        self.password_entry.configure(state="normal")
        self.connect_button.configure(text="Connect and open viewer", state="normal" if self.settings else "disabled")
        self.disconnect_button.configure(text="Disconnect", state="disabled")
        self.status.set(message)
        self.password_entry.focus_set()

    def disconnect(self, message="Disconnected. You can reconnect whenever you need the viewer."):
        self.generation += 1
        connection, self.connection = self.connection, None
        if connection:
            threading.Thread(target=connection.close, daemon=True).start()
        self.reset(message)

    def close(self):
        self.closing = True
        self.generation += 1
        self.password.set("")
        if self.connection:
            # Synchronous cleanup on exit prevents leaving a local listener behind.
            self.connection.close()
        self.root.destroy()


def main():
    logging.getLogger("paramiko").addHandler(logging.NullHandler())
    logging.getLogger("paramiko").propagate=False
    if "--check-config" in sys.argv:
        Settings.load()
        return
    root = tk.Tk()
    app = Launcher(root)
    if "--check-gui" in sys.argv:
        root.update_idletasks()
        assert app.user_entry.winfo_exists() and app.connect_button.winfo_exists()
        assert app.footer.winfo_rooty()+app.footer.winfo_height() <= root.winfo_rooty()+root.winfo_height(), "Window content is clipped"
        root.after(120, app.close)
    root.mainloop()


if __name__ == "__main__":
    main()
