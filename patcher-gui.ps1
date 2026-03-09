Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "FileSplitter Patcher"
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(560, 290)
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true

$title = New-Object System.Windows.Forms.Label
$title.Text = "Choose where to install the FileSplitter patch"
$title.Location = New-Object System.Drawing.Point(18, 16)
$title.Size = New-Object System.Drawing.Size(500, 20)
$title.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($title)

$modeLabel = New-Object System.Windows.Forms.Label
$modeLabel.Text = "Mode"
$modeLabel.Location = New-Object System.Drawing.Point(20, 52)
$modeLabel.Size = New-Object System.Drawing.Size(80, 20)
$form.Controls.Add($modeLabel)

$modeBox = New-Object System.Windows.Forms.ComboBox
$modeBox.Location = New-Object System.Drawing.Point(110, 48)
$modeBox.Size = New-Object System.Drawing.Size(300, 26)
$modeBox.DropDownStyle = "DropDownList"
[void]$modeBox.Items.Add("Installed Equicord (Roaming\Equicord)")
[void]$modeBox.Items.Add("Installed Vencord (Roaming\Vencord)")
[void]$modeBox.Items.Add("Source Repo (Vencord)")
[void]$modeBox.Items.Add("Source Repo (Equicord)")
$modeBox.SelectedIndex = 0
$form.Controls.Add($modeBox)

$pathLabel = New-Object System.Windows.Forms.Label
$pathLabel.Text = "Equicord Path"
$pathLabel.Location = New-Object System.Drawing.Point(20, 90)
$pathLabel.Size = New-Object System.Drawing.Size(90, 20)
$form.Controls.Add($pathLabel)

$pathBox = New-Object System.Windows.Forms.TextBox
$pathBox.Location = New-Object System.Drawing.Point(110, 86)
$pathBox.Size = New-Object System.Drawing.Size(330, 27)
$pathBox.Text = Join-Path $env:APPDATA "Equicord"
$form.Controls.Add($pathBox)

$browseButton = New-Object System.Windows.Forms.Button
$browseButton.Text = "Browse..."
$browseButton.Location = New-Object System.Drawing.Point(448, 85)
$browseButton.Size = New-Object System.Drawing.Size(84, 28)
$form.Controls.Add($browseButton)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = "Installed mode patches %APPDATA%\Equicord. Source mode copies files into src\userplugins\fileSplitter."
$hint.Location = New-Object System.Drawing.Point(20, 124)
$hint.Size = New-Object System.Drawing.Size(512, 34)
$hint.ForeColor = [System.Drawing.Color]::DimGray
$form.Controls.Add($hint)

$restartCheck = New-Object System.Windows.Forms.CheckBox
$restartCheck.Text = "Restart Discord automatically after install or restore"
$restartCheck.Location = New-Object System.Drawing.Point(20, 156)
$restartCheck.Size = New-Object System.Drawing.Size(360, 24)
$restartCheck.Checked = $true
$form.Controls.Add($restartCheck)

$result = $null

function Set-ModeUi {
    if ($modeBox.SelectedIndex -eq 0) {
        $pathLabel.Text = "Equicord Path"
        if ([string]::IsNullOrWhiteSpace($pathBox.Text) -or $pathBox.Text -match "src\\userplugins") {
            $pathBox.Text = Join-Path $env:APPDATA "Equicord"
        }
        $hint.Text = "Installed mode patches %APPDATA%\Equicord using equicord.asar.bak."
        $restoreButton.Enabled = $true
        $restartCheck.Enabled = $true
    } elseif ($modeBox.SelectedIndex -eq 1) {
        $pathLabel.Text = "Vencord Path"
        if ([string]::IsNullOrWhiteSpace($pathBox.Text) -or $pathBox.Text -match "src\\userplugins" -or $pathBox.Text -eq (Join-Path $env:APPDATA "Equicord")) {
            $pathBox.Text = Join-Path $env:APPDATA "Vencord"
        }
        $hint.Text = "Installed mode patches %APPDATA%\Vencord\dist\renderer.js with a backup file."
        $restoreButton.Enabled = $true
        $restartCheck.Enabled = $true
    } elseif ($modeBox.SelectedIndex -eq 2) {
        $pathLabel.Text = "Vencord Repo"
        if ([string]::IsNullOrWhiteSpace($pathBox.Text) -or $pathBox.Text -eq (Join-Path $env:APPDATA "Equicord") -or $pathBox.Text -match "\\Equicord$") {
            $pathBox.Text = Join-Path ([Environment]::GetFolderPath("Desktop")) "Vencord"
        }
        $hint.Text = "Vencord source mode copies FileSplitter into src\userplugins\fileSplitter."
        $restoreButton.Enabled = $false
        $restartCheck.Checked = $false
        $restartCheck.Enabled = $false
    } else {
        $pathLabel.Text = "Equicord Repo"
        if ([string]::IsNullOrWhiteSpace($pathBox.Text) -or $pathBox.Text -eq (Join-Path $env:APPDATA "Equicord") -or $pathBox.Text -match "\\Vencord$") {
            $desktopEquicord = Join-Path ([Environment]::GetFolderPath("Desktop")) "Equicord"
            $pathBox.Text = $desktopEquicord
        }
        $hint.Text = "Equicord source mode copies FileSplitter into src\userplugins\fileSplitter."
        $restoreButton.Enabled = $false
        $restartCheck.Checked = $false
        $restartCheck.Enabled = $false
    }
}

$modeBox.Add_SelectedIndexChanged({ Set-ModeUi })

$browseButton.Add_Click({
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "Select the target folder"
    $dialog.SelectedPath = $pathBox.Text
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $pathBox.Text = $dialog.SelectedPath
    }
})

$installButton = New-Object System.Windows.Forms.Button
$installButton.Text = "Install / Update"
$installButton.Location = New-Object System.Drawing.Point(180, 206)
$installButton.Size = New-Object System.Drawing.Size(110, 32)
$form.Controls.Add($installButton)

$statusButton = New-Object System.Windows.Forms.Button
$statusButton.Text = "Status"
$statusButton.Location = New-Object System.Drawing.Point(298, 206)
$statusButton.Size = New-Object System.Drawing.Size(84, 32)
$form.Controls.Add($statusButton)

$restoreButton = New-Object System.Windows.Forms.Button
$restoreButton.Text = "Restore"
$restoreButton.Location = New-Object System.Drawing.Point(390, 206)
$restoreButton.Size = New-Object System.Drawing.Size(84, 32)
$form.Controls.Add($restoreButton)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = "Cancel"
$cancelButton.Location = New-Object System.Drawing.Point(480, 206)
$cancelButton.Size = New-Object System.Drawing.Size(64, 32)
$form.Controls.Add($cancelButton)

$emit = {
    param([string]$action)
    if ([string]::IsNullOrWhiteSpace($pathBox.Text)) {
        [System.Windows.Forms.MessageBox]::Show("Please choose a target path.", "FileSplitter Patcher",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
        return
    }

    $mode = if ($modeBox.SelectedIndex -eq 0) {
        "installed"
    } elseif ($modeBox.SelectedIndex -eq 1) {
        "installed-vencord"
    } else {
        "source"
    }
    $sourceFlavor = if ($modeBox.SelectedIndex -eq 2) {
        "vencord"
    } elseif ($modeBox.SelectedIndex -eq 3) {
        "equicord"
    } else {
        $null
    }
    $script:result = @{
        action = $action
        mode = $mode
        sourceFlavor = $sourceFlavor
        path = $pathBox.Text
        restartClient = $restartCheck.Checked
    } | ConvertTo-Json -Compress
    $form.Close()
}

$installButton.Add_Click({ & $emit "install" })
$statusButton.Add_Click({ & $emit "status" })
$restoreButton.Add_Click({ & $emit "restore" })
$cancelButton.Add_Click({ $form.Close() })

Set-ModeUi
[void]$form.ShowDialog()

if ($result) {
    Write-Output $result
}
