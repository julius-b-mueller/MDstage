wanted_characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzßÄÖÜäöü1234567890`<>*-.,#?!'\n\"': "

with open ("../frontend/script.md", "r") as infile:
    script = infile.read()

script_clean = ""

for character in script:
    if character in wanted_characters:
        script_clean += character
    else:
        script_clean += "@"

with open ("script-clean.md", "w") as outfile:
    outfile.write(script_clean)
