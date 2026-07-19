import subprocess, os

os.chdir(r"C:\Users\user\Desktop\BRCsystem")
subprocess.run(["git", "add", "-A"])
subprocess.run(["git", "commit", "-m", "update"])
subprocess.run(["git", "push", "origin", "main"])