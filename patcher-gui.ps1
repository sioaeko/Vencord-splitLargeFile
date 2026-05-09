Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "FileSplitter Patcher"
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(560, 420)
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

function Show-GuiMessage {
    param(
        [string]$Title,
        [string]$Message,
        [System.Windows.Forms.MessageBoxIcon]$Icon = [System.Windows.Forms.MessageBoxIcon]::Information
    )

    [System.Windows.Forms.MessageBox]::Show($form, $Message, $Title,
        [System.Windows.Forms.MessageBoxButtons]::OK,
        $Icon) | Out-Null
}

function Set-Busy {
    param([bool]$Busy)

    $modeBox.Enabled = -not $Busy
    $pathBox.Enabled = -not $Busy
    $browseButton.Enabled = -not $Busy
    $installButton.Enabled = -not $Busy
    $statusButton.Enabled = -not $Busy
    $restoreButton.Enabled = (-not $Busy) -and ($modeBox.SelectedIndex -lt 2)
    $cancelButton.Enabled = -not $Busy
    $restartCheck.Enabled = (-not $Busy) -and ($modeBox.SelectedIndex -lt 2)
    $form.Cursor = if ($Busy) { [System.Windows.Forms.Cursors]::WaitCursor } else { [System.Windows.Forms.Cursors]::Default }
    $form.Refresh()
}

function Get-PatcherSelf {
    if ([string]::IsNullOrWhiteSpace($env:FILESPLITTER_PATCHER_SELF)) {
        throw "Internal error: FILESPLITTER_PATCHER_SELF is not set."
    }

    return $env:FILESPLITTER_PATCHER_SELF | ConvertFrom-Json
}

function Get-CliArgs {
    param([string]$Action)

    $argList = New-Object System.Collections.Generic.List[string]

    if ($modeBox.SelectedIndex -eq 0) {
        if ($Action -eq "install") {
            [void]$argList.Add("--install")
        } elseif ($Action -eq "status") {
            [void]$argList.Add("--status")
        } else {
            [void]$argList.Add("--restore")
        }
        [void]$argList.Add("--equicord-root")
        [void]$argList.Add($pathBox.Text)
    } elseif ($modeBox.SelectedIndex -eq 1) {
        if ($Action -eq "install") {
            [void]$argList.Add("--install-vencord")
        } elseif ($Action -eq "status") {
            [void]$argList.Add("--status-vencord")
        } else {
            [void]$argList.Add("--restore-vencord")
        }
        [void]$argList.Add("--vencord-root")
        [void]$argList.Add($pathBox.Text)
    } else {
        if ($Action -eq "install") {
            [void]$argList.Add("--install-source")
        } else {
            [void]$argList.Add("--status-source")
        }
        [void]$argList.Add("--repo")
        [void]$argList.Add($pathBox.Text)
    }

    if (($Action -eq "install" -or $Action -eq "restore") -and $modeBox.SelectedIndex -lt 2 -and $restartCheck.Checked) {
        [void]$argList.Add("--restart-client")
    }

    return $argList
}

function Invoke-PatcherAction {
    param([string]$Action)

    $self = Get-PatcherSelf
    $cliArgs = Get-CliArgs $Action
    $allArgs = New-Object System.Collections.Generic.List[string]

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = [string]$self.command
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    foreach ($arg in @($self.args)) {
        if ($null -ne $arg -and -not [string]::IsNullOrWhiteSpace([string]$arg)) {
            [void]$allArgs.Add([string]$arg)
        }
    }

    foreach ($arg in $cliArgs) {
        [void]$allArgs.Add([string]$arg)
    }

    $quotedArgs = $allArgs | ForEach-Object {
        '"' + ([string]$_).Replace('"', '\"') + '"'
    }
    $psi.Arguments = ($quotedArgs -join " ")

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    return [PSCustomObject]@{
        ExitCode = $process.ExitCode
        Stdout = $stdout.Trim()
        Stderr = $stderr.Trim()
    }
}

function Get-ActionLabel {
    param([string]$Action)

    if ($Action -eq "install") {
        return "Install complete."
    }
    if ($Action -eq "restore") {
        return "Restore complete."
    }
    return "Status check complete."
}

function Format-ActionOutput {
    param(
        [string]$Action,
        [object]$Result
    )

    $parts = New-Object System.Collections.Generic.List[string]
    [void]$parts.Add((Get-ActionLabel $Action))
    if (-not [string]::IsNullOrWhiteSpace($Result.Stdout)) {
        [void]$parts.Add($Result.Stdout)
    }
    if (-not [string]::IsNullOrWhiteSpace($Result.Stderr)) {
        [void]$parts.Add("Warnings / errors:`r`n$($Result.Stderr)")
    }

    return ($parts -join "`r`n`r`n")
}

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
$cancelButton.Text = "Close"
$cancelButton.Location = New-Object System.Drawing.Point(480, 206)
$cancelButton.Size = New-Object System.Drawing.Size(64, 32)
$form.Controls.Add($cancelButton)

$resultBox = New-Object System.Windows.Forms.TextBox
$resultBox.Location = New-Object System.Drawing.Point(20, 250)
$resultBox.Size = New-Object System.Drawing.Size(512, 110)
$resultBox.Multiline = $true
$resultBox.ReadOnly = $true
$resultBox.ScrollBars = "Vertical"
$resultBox.Visible = $false
$form.Controls.Add($resultBox)

$emit = {
    param([string]$action)
    if ([string]::IsNullOrWhiteSpace($pathBox.Text)) {
        Show-GuiMessage "FileSplitter Patcher" "Please choose a target path." ([System.Windows.Forms.MessageBoxIcon]::Warning)
        return
    }

    try {
        Set-Busy $true
        $hint.Text = "Working... this may take a moment."
        $resultBox.Visible = $false
        $resultBox.Text = ""
        $form.Refresh()

        $result = Invoke-PatcherAction $action
        $message = Format-ActionOutput $action $result
        $resultBox.Text = $message
        $resultBox.Visible = $true
        $hint.Text = Get-ActionLabel $action
        Set-Busy $false

        if ($result.ExitCode -eq 0) {
            Show-GuiMessage "FileSplitter Patcher" $message ([System.Windows.Forms.MessageBoxIcon]::Information)
        } else {
            Show-GuiMessage "FileSplitter Patcher Error" $message ([System.Windows.Forms.MessageBoxIcon]::Error)
        }
    } catch {
        Set-Busy $false
        $hint.Text = "Action failed."
        $resultBox.Text = $_.Exception.Message
        $resultBox.Visible = $true
        Show-GuiMessage "FileSplitter Patcher Error" ($_.Exception.Message) ([System.Windows.Forms.MessageBoxIcon]::Error)
    }
}

$installButton.Add_Click({ & $emit "install" })
$statusButton.Add_Click({ & $emit "status" })
$restoreButton.Add_Click({ & $emit "restore" })
$cancelButton.Add_Click({ $form.Close() })

Set-ModeUi
[void]$form.ShowDialog()
