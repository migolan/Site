﻿using System;
using System.Collections.Generic;
using System.Configuration;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace IsraelHiking.DataAccess
{
    public class GpsBabelGateway
    {
        private readonly Logger _logger;

        public GpsBabelGateway()
        {
            _logger = new Logger();
        }

        public string ConvertFileFromat(string filePath, string outputFromat)
        {
            var extension = Path.GetExtension(filePath);
            var outputFileName = Path.Combine(Path.GetDirectoryName(filePath), Path.GetFileNameWithoutExtension(filePath) + "." + outputFromat);
            var workingDirectory = ConfigurationManager.AppSettings["gpsbabel"].ToString();
            var executable = "gpsbabel.exe";
            var agruments = "-i " + ConvertExtenstionToFormat(extension) + " -f " + filePath + " -o " + ConvertExtenstionToFormat(outputFromat) + " -F " + outputFileName;
            _logger.Debug("Running: " + Path.Combine(workingDirectory, executable) + " " + agruments);
            var process = Process.Start(new ProcessStartInfo
            {
                FileName = executable,
                Arguments = agruments,
                WorkingDirectory = workingDirectory,
            });
            process.WaitForExit(10000);
            return outputFileName;
        }

        private string ConvertExtenstionToFormat(string extension)
        {
            extension = extension.Replace(".", "");
            if (extension == "twl")
            {
                return "naviguide";
            }
            return extension;
        }
    }
}
